import { ethers } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

import { FixedPoint } from "./FixedPoint";

export class Tick {
  static Zero = ethers.constants.Zero;

  static encode(limit: string | BigNumber, durationIndex?: number = 2, rateIndex?: number = 0) {
    return (typeof limit === "string" ? FixedPoint.from(limit) : limit)
      .mask(120)
      .mul(256)
      .add(ethers.BigNumber.from(durationIndex).mask(3).mul(32))
      .add(ethers.BigNumber.from(rateIndex).mask(3).mul(4));
  }

  static decode(tick: BigNumber): { limit: BigNumber; durationIndex: number; rateIndex: number } {
    return {
      limit: tick.div(256).mask(120),
      durationIndex: tick.div(32).mask(3),
      rateIndex: tick.div(4).mask(3),
    };
  }
}
