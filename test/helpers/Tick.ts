import { ethers } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import { FixedPoint } from "./FixedPoint";

export class Tick {
  static Zero = 0n;

  static encode(
    limit: string | bigint,
    durationIndex: number = 0,
    rateIndex: number = 0,
    decimals: number = 18,
    limitType: number = 0
  ) {
    // Convert limit to BigInt if it's a string, otherwise use it directly
    const limitBigInt = typeof limit === "string" ? FixedPoint.from(limit) : BigInt(limit);

    // Perform the necessary calculations with BigInt
    const baseValue = limitBigInt * BigInt(10 ** (18 - decimals));

    // Mask the baseValue with 120 bits (equivalent to value & (2**120 - 1))
    const maskedBaseValue = baseValue & ((BigInt(1) << BigInt(120)) - BigInt(1));

    const result =
      maskedBaseValue * BigInt(256) +
      (BigInt(durationIndex) & ((BigInt(1) << BigInt(3)) - BigInt(1))) * BigInt(32) +
      (BigInt(rateIndex) & ((BigInt(1) << BigInt(3)) - BigInt(1))) * BigInt(4) +
      (BigInt(limitType) & ((BigInt(1) << BigInt(2)) - BigInt(1)));

    return result;
  }

  static decode(
    tick: bigint,
    oraclePrice: bigint = 0n
  ): { limit: bigint; durationIndex: number; rateIndex: number; limitType: number } {
    // Masking to get specific bits
    const maskBits = (value: bigint, bits: number): bigint => value & ((1n << BigInt(bits)) - 1n);

    // Decode the limit
    const limit =
      maskBits(tick, 2) === 0n ? maskBits(tick / 256n, 120) : (maskBits(tick / 256n, 120) * oraclePrice) / 10000n;

    // Decode durationIndex
    const durationIndex = Number(maskBits(tick / 32n, 3));

    // Decode rateIndex
    const rateIndex = Number(maskBits(tick / 4n, 3));

    // Decode limitType
    const limitType = Number(maskBits(tick, 2));

    return {
      limit,
      durationIndex,
      rateIndex,
      limitType,
    };
  }
}
