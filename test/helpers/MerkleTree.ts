import { ethers } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

export class MerkleTree {
  static buildTree(values: any[][], encodings: string[]): StandardMerkleTree<any> {
    return StandardMerkleTree.of(values, encodings);
  }

  static buildProof(value: any, nodeCount: number, tree: StandardMerkleTree<any>): string {
    value = ethers.BigNumber.isBigNumber(value) ? value.toString() : value;
    for (const [i, v] of tree.entries()) {
      const v0 = ethers.BigNumber.isBigNumber(v[0]) ? v[0].toString() : v[0];
      if (v0 === value) {
        const proof = tree.getProof(i); /* in shape of bytes32[] */
        if (proof.length != nodeCount) {
          proof.push(ethers.constants.HashZero);
        }
        return ethers.utils.solidityPack(Array(proof.length).fill("bytes32"), proof);
      }
    }
    throw new Error("Input value is not part of tree");
  }

  static buildProofs(values: any[], nodeCount: number, tree: StandardMerkleTree<any>): string {
    values = values.map((v) => {
      return ethers.BigNumber.isBigNumber(v) ? v.toString() : v;
    });

    const proofs: string[] = [];
    for (const [index, value] of values.entries()) {
      for (const [i, v] of tree.entries()) {
        const v0 = ethers.BigNumber.isBigNumber(v[0]) ? v[0].toString() : v[0];
        if (v0 === value) {
          const proof = tree.getProof(i); /* in shape of bytes32[] */
          if (proof.length != nodeCount) {
            proof.push(ethers.constants.HashZero);
          }
          proofs.push(ethers.utils.solidityPack(Array(proof.length).fill("bytes32"), proof));
        }
      }
      if (index != proofs.length - 1) {
        throw new Error(`Input value ${value} is not part of tree`);
      }
    }

    return ethers.utils.solidityPack(Array(proofs.length).fill("bytes"), proofs);
  }
}
