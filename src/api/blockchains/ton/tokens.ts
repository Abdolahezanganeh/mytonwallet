import type { JettonBalance } from 'tonapi-sdk-js';
import { Address, Cell } from '@ton/core';

import type {
  ApiBaseToken, ApiNetwork, ApiToken, ApiTokenSimple,
} from '../../types';
import type { AnyPayload, ApiTransactionExtra, JettonMetadata } from './types';

import {
  DEFAULT_DECIMAL_PLACES, TINY_TOKENS, TON_SYMBOL, TONCOIN_SLUG,
} from '../../../config';
import { parseAccountId } from '../../../util/account';
import { fetchJson } from '../../../util/fetch';
import { logDebugError } from '../../../util/logs';
import { fixIpfsUrl } from '../../../util/metadata';
import { buildTokenSlug } from './util';
import {
  fetchJettonMetadata,
  fixBase64ImageData,
  parseJettonWalletMsgBody,
} from './util/metadata';
import { fetchJettonBalances } from './util/tonapiio';
import {
  buildTokenTransferBody,
  getTonClient,
  resolveTokenMinterAddress,
  resolveTokenWalletAddress,
  toBase64Address, toRawAddress,
} from './util/tonCore';
import { JettonWallet } from './contracts/JettonWallet';
import { fetchStoredAddress } from '../../common/accounts';
import {
  CLAIM_MINTLESS_AMOUNT,
  DEFAULT_DECIMALS,
  TINY_TOKEN_TRANSFER_AMOUNT,
  TOKEN_TRANSFER_AMOUNT,
  TOKEN_TRANSFER_FORWARD_AMOUNT,
} from './constants';
import { isActiveSmartContract } from './wallet';

export type TokenBalanceParsed = {
  slug: string;
  balance: bigint;
  token: ApiTokenSimple;
  jettonWallet: string;
};

const KNOWN_TOKENS: ApiBaseToken[] = [
  {
    slug: TONCOIN_SLUG,
    name: 'Toncoin',
    cmcSlug: TONCOIN_SLUG,
    symbol: TON_SYMBOL,
    decimals: DEFAULT_DECIMAL_PLACES,
  },
];

const knownTokens = {} as Record<string, ApiToken>;
addKnownTokens(KNOWN_TOKENS);

export async function getAccountTokenBalances(accountId: string) {
  const { network } = parseAccountId(accountId);
  const address = await fetchStoredAddress(accountId);

  return getTokenBalances(network, address);
}

export async function getTokenBalances(network: ApiNetwork, address: string) {
  const balancesRaw = await fetchJettonBalances(network, address);
  return balancesRaw.map((balance) => parseTokenBalance(network, balance)).filter(Boolean);
}

export async function getAddressTokenBalances(address: string, network: ApiNetwork) {
  const balancesRaw = await fetchJettonBalances(network, address);
  return balancesRaw.map((balance) => parseTokenBalance(network, balance)).filter(Boolean);
}

function parseTokenBalance(network: ApiNetwork, balanceRaw: JettonBalance): TokenBalanceParsed | undefined {
  if (!balanceRaw.jetton) {
    return undefined;
  }

  try {
    const {
      balance, jetton, wallet_address: walletAddress,
    } = balanceRaw;
    const minterAddress = toBase64Address(jetton.address, true, network);
    const token = buildTokenByMetadata(minterAddress, jetton);

    return {
      slug: token.slug,
      balance: BigInt(balance),
      token,
      jettonWallet: toBase64Address(walletAddress.address, undefined, network),
    };
  } catch (err) {
    logDebugError('parseTokenBalance', err);
    return undefined;
  }
}

export function parseTokenTransaction(
  network: ApiNetwork,
  tx: ApiTransactionExtra,
  slug: string,
  walletAddress: string,
): ApiTransactionExtra | undefined {
  const { extraData } = tx;
  if (!extraData?.body) {
    return undefined;
  }

  const parsedData = parseJettonWalletMsgBody(network, extraData.body);
  if (!parsedData) {
    return undefined;
  }

  const {
    operation, jettonAmount, address, comment, encryptedComment,
  } = parsedData;
  const isIncoming = operation === 'InternalTransfer';

  const fromAddress = isIncoming ? (address ?? tx.fromAddress) : walletAddress;
  const toAddress = isIncoming ? walletAddress : address!;
  const normalizedAddress = toBase64Address(isIncoming ? fromAddress : toAddress, true);

  return {
    ...tx,
    slug,
    fromAddress,
    toAddress,
    normalizedAddress,
    amount: isIncoming ? jettonAmount : -jettonAmount,
    comment,
    encryptedComment,
    isIncoming,
  };
}

export async function buildTokenTransfer(
  network: ApiNetwork,
  tokenAddress: string,
  fromAddress: string,
  toAddress: string,
  amount: bigint,
  payload?: AnyPayload,
) {
  const tokenWalletAddress = await resolveTokenWalletAddress(network, fromAddress, tokenAddress);
  const tokenWallet = getTokenWallet(network, tokenWalletAddress);
  const token = findTokenByMinter(tokenAddress)!;

  let isTokenWalletDeployed = true;
  let customPayload: string | undefined;
  let stateInit: string | undefined;

  const isMintlessToken = !!token.customPayloadApiUrl;
  let isMintlessClaimed: boolean | undefined;
  let mintlessTokenBalance: bigint | undefined;

  if (isMintlessToken) {
    isTokenWalletDeployed = !!(await isActiveSmartContract(network, tokenWalletAddress));
    isMintlessClaimed = isTokenWalletDeployed && await checkMintlessTokenWalletIsClaimed(network, tokenWalletAddress);

    if (!isMintlessClaimed) {
      const data = await fetchMintlessTokenWalletData(token.customPayloadApiUrl!, fromAddress);

      if (data) {
        customPayload = data.custom_payload;
        mintlessTokenBalance = BigInt(data.compressed_info.amount);

        if (!isTokenWalletDeployed) {
          stateInit = data.state_init;
        }
      }
    }
  }

  if (isTokenWalletDeployed) {
    const realTokenAddress = await resolveTokenMinterAddress(network, tokenWalletAddress);
    if (tokenAddress !== realTokenAddress) {
      throw new Error('Invalid contract');
    }
  }

  payload = buildTokenTransferBody({
    tokenAmount: amount,
    toAddress,
    forwardAmount: TOKEN_TRANSFER_FORWARD_AMOUNT,
    forwardPayload: payload,
    responseAddress: fromAddress,
    customPayload: customPayload ? Cell.fromBase64(customPayload) : undefined,
  });

  let toncoinAmount = TINY_TOKENS.has(tokenAddress)
    ? TINY_TOKEN_TRANSFER_AMOUNT
    : TOKEN_TRANSFER_AMOUNT;

  if (mintlessTokenBalance && !isMintlessClaimed) {
    toncoinAmount += CLAIM_MINTLESS_AMOUNT;
  }

  return {
    tokenWallet,
    amount: toncoinAmount,
    toAddress: tokenWalletAddress,
    payload,
    stateInit: stateInit ? Cell.fromBase64(stateInit) : undefined,
    mintlessTokenBalance,
    isTokenWalletDeployed,
  };
}

export async function checkMintlessTokenWalletIsClaimed(network: ApiNetwork, tokenWalletAddress: string) {
  const res = await getTonClient(network)
    .runMethod(Address.parse(tokenWalletAddress), 'is_claimed');
  return res.stack.readBoolean();
}

async function fetchMintlessTokenWalletData(customPayloadApiUrl: string, address: string) {
  const rawAddress = toRawAddress(address);

  return (await fetchJson(`${customPayloadApiUrl}/wallet/${rawAddress}`).catch(() => undefined)) as {
    custom_payload: string;
    state_init: string;
    compressed_info: {
      amount: string;
    };
  } | undefined;
}

export function resolveTokenBySlug(slug: string) {
  return knownTokens[slug]!;
}

export function findTokenByMinter(minter: string) {
  return Object.values(knownTokens).find((token) => token.minterAddress === minter);
}

export function getTokenWallet(network: ApiNetwork, tokenAddress: string) {
  return getTonClient(network).open(new JettonWallet(Address.parse(tokenAddress)));
}

export function getKnownTokens() {
  return knownTokens;
}

export function addKnownTokens(tokens: ApiBaseToken[]) {
  for (const token of tokens) {
    if (token.slug in knownTokens) continue;

    addKnownToken({
      ...token,
      quote: {
        slug: token.slug,
        price: 0,
        priceUsd: 0,
        percentChange24h: 0,
      },
    });
  }
}

export function addKnownToken(token: ApiToken) {
  knownTokens[token.slug] = token;
}

export async function fetchToken(network: ApiNetwork, address: string) {
  const metadata = await fetchJettonMetadata(network, address);

  return buildTokenByMetadata(address, metadata);
}

function buildTokenByMetadata(address: string, metadata: JettonMetadata): ApiBaseToken {
  const {
    name,
    symbol,
    image,
    image_data: imageData,
    decimals,
    custom_payload_api_uri: customPayloadApiUrl,
  } = metadata;

  return {
    slug: buildTokenSlug(address),
    name,
    symbol,
    decimals: decimals === undefined ? DEFAULT_DECIMALS : Number(decimals),
    minterAddress: address,
    image: (image && fixIpfsUrl(image)) || (imageData && fixBase64ImageData(imageData)) || undefined,
    customPayloadApiUrl,
  };
}
