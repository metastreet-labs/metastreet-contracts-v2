import { ethers } from "hardhat";

export class FixedPoint {
  static Zero = 0n;

  static from(x: string | number | bigint, decimals?: number = 18): bigint {
    if (typeof x === "string") {
      return ethers.parseEther(x) / BigInt(10 ** (18 - decimals));
    } else if (typeof x === "number") {
      return (BigInt(x) * ethers.WeiPerEther) / BigInt(10 ** (18 - decimals));
    } else {
      return (x * ethers.WeiPerEther) / BigInt(10 ** (18 - decimals));
    }
  }

  static mul(x: bigint, y: bigint): bigint {
    return (x * y) / ethers.WeiPerEther;
  }

  static div(x: bigint, y: bigint): bigint {
    return (x * ethers.WeiPerEther) / y;
  }

  static normalizeRate(rate: string | number | bigint): bigint {
    return FixedPoint.from(rate) / BigInt(365 * 86400);
  }
}
