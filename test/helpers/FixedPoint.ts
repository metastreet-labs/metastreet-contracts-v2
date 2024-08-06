import { ethers } from "hardhat";

import { BigNumber } from "@ethersproject/bignumber";

export class FixedPoint {
  static Zero = ethers.constants.Zero;

  static from(x: string | number | BigNumber, decimals: number = 18): BigNumber {
    if (typeof x === "string") {
      return ethers.utils.parseEther(x).div(10 ** (18 - decimals));
    } else if (typeof x === "number") {
      return ethers.BigNumber.from(x)
        .mul(ethers.constants.WeiPerEther)
        .div(10 ** (18 - decimals));
    } else {
      return x.mul(ethers.constants.WeiPerEther).div(10 ** (18 - decimals));
    }
  }

  static mul(x: BigNumber, y: BigNumber): BigNumber {
    return x.mul(y).div(ethers.constants.WeiPerEther);
  }

  static div(x: BigNumber, y: BigNumber): BigNumber {
    return x.mul(ethers.constants.WeiPerEther).div(y);
  }

  static normalizeRate(rate: string | number | BigNumber): BigNumber {
    return FixedPoint.from(rate).div(365 * 86400);
  }
}
