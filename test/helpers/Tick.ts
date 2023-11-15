import { ethers } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import { FixedPoint } from "./FixedPoint";

export class Tick {
  static Zero = ethers.constants.Zero;

  static encode(
    limit: string | BigNumber,
    durationIndex?: number = 0,
    rateIndex?: number = 0,
    decimals?: number = 18,
    limitType?: number = 0
  ) {
    return (typeof limit === "string" ? FixedPoint.from(limit) : limit)
      .mul(10 ** (18 - decimals))
      .mask(120)
      .mul(256)
      .add(ethers.BigNumber.from(durationIndex).mask(3).mul(32))
      .add(ethers.BigNumber.from(rateIndex).mask(3).mul(4))
      .add(ethers.BigNumber.from(limitType).mask(2));
  }

  static decode(
    tick: BigNumber,
    oraclePrice?: BigNumber = ethers.constants.Zero
  ): { limit: BigNumber; durationIndex: number; rateIndex: number; limitType: number } {
    return {
      limit: tick.mask(2).eq(0)
        ? tick.div(256).mask(120)
        : tick.div(256).mask(120).mul(oraclePrice).div(ethers.BigNumber.from(10000)),
      durationIndex: tick.div(32).mask(3),
      rateIndex: tick.div(4).mask(3),
      limitType: tick.mask(2),
    };
  }
}
