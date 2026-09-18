export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL = "So11111111111111111111111111111111111111112";

export interface Stock {
  ticker: string;
  name: string;
  xSymbol: string;
  mint: string;
  decimals: number;
  pythEquity?: string;
  pythX?: string;
}

/** Mainnet xStocks (Backed) + Pyth Core feed ids where known. */
export const STOCKS: Stock[] = [
  {
    ticker: "AAPL",
    name: "Apple",
    xSymbol: "AAPLx",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    pythEquity: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    pythX: "978e6cc68a119ce066aa830017318563a9ed04ec3a0a6439010fc11296a58675",
  },
  {
    ticker: "NVDA",
    name: "NVIDIA",
    xSymbol: "NVDAx",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    pythEquity: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    pythX: "4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f",
  },
  {
    ticker: "TSLA",
    name: "Tesla",
    xSymbol: "TSLAx",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    pythEquity: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
  },
  {
    ticker: "GME",
    name: "GameStop",
    xSymbol: "GMEx",
    mint: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc",
    decimals: 8,
    pythEquity: "6f9cd89ef1b7fd39f667101a91ad578b6c6ace4579d5f7f285a4b06aa4504be6",
  },
  {
    ticker: "HOOD",
    name: "Robinhood",
    xSymbol: "HOODx",
    mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
    decimals: 8,
    pythEquity: "306736a4035846ba15a3496eed57225b64cc19230a50d14f3ed20fd7219b7849",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet",
    xSymbol: "GOOGLx",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    decimals: 8,
  },
  {
    ticker: "AMZN",
    name: "Amazon",
    xSymbol: "AMZNx",
    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    decimals: 8,
  },
  {
    ticker: "MSFT",
    name: "Microsoft",
    xSymbol: "MSFTx",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    decimals: 8,
  },
  {
    ticker: "META",
    name: "Meta",
    xSymbol: "METAx",
    mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    decimals: 8,
  },
  {
    ticker: "SPY",
    name: "S&P 500 ETF",
    xSymbol: "SPYx",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
  },
  {
    ticker: "COIN",
    name: "Coinbase",
    xSymbol: "COINx",
    mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    decimals: 8,
  },
  {
    ticker: "MSTR",
    name: "Strategy",
    xSymbol: "MSTRx",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    decimals: 8,
  },
];

export function stockByTicker(ticker: string) {
  const t = ticker.trim().toUpperCase();
  return STOCKS.find((s) => s.ticker === t || s.xSymbol.toUpperCase() === t) || null;
}
