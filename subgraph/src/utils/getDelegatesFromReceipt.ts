import { Address, ethereum } from "@graphprotocol/graph-ts";
import { decodeLogData } from "./decodeLogData";

class Delegates {
  v1: Address | null;
  v2: Address | null;

  constructor() {
    this.v1 = null;
    this.v2 = null;
  }
}

const DELEGATE_FOR_TOKEN_TOPIC = "0xe89c6ba1e8957285aed22618f52aa1dcb9d5bb64e1533d8b55136c72fcf5aa5d";
const DELEGATE_ERC721_TOPIC = "0x15e7a1bdcd507dd632d797d38e60cc5a9c0749b9a63097a215c4d006126825c6";

export function getDelegatesFromReceipt(receipt: ethereum.TransactionReceipt | null): Delegates {
  const delegates = new Delegates();

  if (receipt == null) return delegates;

  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    const topic = log.topics[0].toHexString();
    if (topic == DELEGATE_FOR_TOKEN_TOPIC) {
      const logData = decodeLogData("(address,address,address,uint256,bool)", log);
      if (logData) delegates.v1 = logData.at(1).toAddress();
    } else if (topic == DELEGATE_ERC721_TOPIC) {
      const logData = decodeLogData("(address,address,address,uint256,bytes32,bool)", log);
      if (logData) delegates.v2 = logData.at(2).toAddress();
    }
  }

  return delegates;
}
