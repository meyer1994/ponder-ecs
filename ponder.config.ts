import { createConfig } from "ponder";
import { erc20ABI } from "./abis/erc20ABI";

export default createConfig({
  database: {
    kind: "postgres",
    connectionString: process.env.DATABASE_URL,
  },
  chains: {
    mainnet: {
      id: 1,
      rpc: "https://eth-mainnet.g.alchemy.com/v2/-DCWWtN-4yo84gKA0Blrd4ke92PiOUGv",
    },
  },
  contracts: {
    ERC20: {
      chain: "mainnet",
      abi: erc20ABI,
      address: "0x32353A6C91143bfd6C7d363B546e62a9A2489A20",
      startBlock: 13142655,
      endBlock: 13150000,
    },
  },
});
