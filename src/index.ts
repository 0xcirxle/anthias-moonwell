import { ponder } from "ponder:registry";
import { marketParameters, userPositions, userTransactions } from "ponder:schema";
// Add imports for direct contract interaction testing
import { createPublicClient, http, defineChain } from "viem";
import { ComptrollerAbi } from "../abis/Comptroller";
// ABI types for correct contract interactions
type BorrowEvent = {
  borrower: `0x${string}`;
  borrowAmount: bigint;
  accountBorrows: bigint;
  totalBorrows: bigint;
};

type RepayBorrowEvent = {
  payer: `0x${string}`;
  borrower: `0x${string}`;
  repayAmount: bigint;
  accountBorrows: bigint;
  totalBorrows: bigint;
};

type MintEvent = {
  minter: `0x${string}`;
  mintAmount: bigint;
  mintTokens: bigint;
};

type RedeemEvent = {
  redeemer: `0x${string}`;
  redeemAmount: bigint;
  redeemTokens: bigint;
};

type LiquidateBorrowEvent = {
  liquidator: `0x${string}`;
  borrower: `0x${string}`;
  repayAmount: bigint;
  mTokenCollateral: `0x${string}`;
  seizeTokens: bigint;
};

// Constants for contract addresses
const COMPTROLLER_ADDRESS = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";
const M_TOKEN_ETH_ADDRESS = "0x628ff693426583D9a7FB391E54366292F509D457";

// Create a properly defined chain for Base
const baseChain = defineChain({
  id: 8453,
  name: 'Base',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [process.env.PONDER_RPC_URL_8453 || "https://mainnet.base.org"],
    },
    public: {
      http: ["https://mainnet.base.org"],
    },
  },
});

// Create a direct viem client for testing
const directClient = createPublicClient({
  chain: baseChain,
  transport: http(process.env.PONDER_RPC_URL_8453 || "https://mainnet.base.org"),
});

// Market Parameters tracking on each block
ponder.on("MarketParamsCheck:block", async ({ event, context }) => {
  try {
    const { db } = context;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    
    // Initialize with default values in case contract calls fail
    let totalBorrows = 0n;
    let cash = 0n;
    let reserves = 0n;
    let reserveFactor = 0n;
    let borrowCap = 0n;
    let supplyCap = 0n;
    let collateralFactor = 0n;
    let liquidationIncentive = 0n;
    let utilization = 0;
    
    console.log(`\n---------- WETH METRICS (Block ${blockNumber}) ----------`);

    // A) MToken calls for market data
    try {
      totalBorrows = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "totalBorrows",
      });
      console.log(`→ Total Borrows: ${Number(totalBorrows) / 1e18} ETH`);
    } catch (error) {
      console.log("→ Error reading totalBorrows");
    }

    try {
      cash = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "getCash",
      });
      console.log(`→ Cash: ${Number(cash) / 1e18} ETH`);
    } catch (error) {
      console.log("→ Error reading getCash");
    }

    try {
      reserves = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "totalReserves",
      });
      console.log(`→ Reserves: ${Number(reserves) / 1e18} ETH`);
    } catch (error) {
      console.log("→ Error reading totalReserves");
    }

    try {
      reserveFactor = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "reserveFactorMantissa",
      });
      const reserveFactorPct = Number(reserveFactor) / 1e18 * 100;
      console.log(`→ Reserve factor: ${reserveFactorPct.toFixed(2)}%`);
    } catch (error) {
      console.log("→ Error reading reserveFactorMantissa");
    }

    // B) Compute utilization (only if we have valid data)
    const sumBig = totalBorrows + cash;
    if (sumBig > 0n) {
      utilization = Number(totalBorrows) / Number(sumBig);
      console.log(`→ Utilization: ${(utilization * 100).toFixed(2)}%`);
    }
    
    // C) Liquidity = Supplied - Borrowed (in this case, cash is the supplied amount not yet borrowed)
    const liquidity = Number(cash) / 1e18;
    console.log(`→ Liquidity (Supplied - Borrowed): ${liquidity.toFixed(4)} ETH`);

    console.log(`--------------------------------------------\n`);

    // 3) Write to the DB even if some values are default/0
    try {
      await db.insert(marketParameters).values({
        mTokenAddress: context.contracts.MToken.address,
        blockNumber: BigInt(blockNumber),
        price: 0n, // No price for now
        totalBorrows,
        utilization,
        collateralFactor,
        reserves,
        reserveFactor,
        supplyCap,
        borrowCap,
        liquidationIncentive,
        borrowEnabled: false, // Default value 
        blockTimestamp: BigInt(blockTimestamp),
      });
    } catch (error) {
      console.error(`Error inserting market parameters:`, error);
    }
  } catch (error) {
    console.error(`Error processing block:`, error);
  }
});

// Handler for Borrow events
ponder.on("MToken:Borrow", async ({ event, context }) => {
  try {
    const { db } = context;
    const { borrower, borrowAmount, accountBorrows, totalBorrows } = event.args;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    const txHash = event.transaction.hash;
    const logIndex = event.log.logIndex;
    
    console.log(`Processing Borrow: ${borrower} with amount ${borrowAmount}`);

    // 1. Record the transaction
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}`,
        userAddress: borrower,
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "BORROW",
        amount: borrowAmount,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
      });
    } catch (error) {
      console.error(`Error recording borrow transaction:`, error);
    }
    
    // 2. Update or create user position
    // Get current mToken balance (supply position)
    let supplyBalance = 0n;
    try {
      supplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [borrower],
      });
    } catch (error) {
      console.error(`Error reading balance for ${borrower}:`, error);
    }
    
    // Create position ID
    const positionId = `${borrower}-${M_TOKEN_ETH_ADDRESS}`;
    
    try {
      // Use upsert pattern with the store API
      await db.insert(userPositions)
        .values({
          id: positionId,
          userAddress: borrower,
          mTokenAddress: M_TOKEN_ETH_ADDRESS,
          borrowBalance: accountBorrows,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        })
        .onConflictDoUpdate((row) => ({ 
          borrowBalance: accountBorrows,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        }));
    } catch (error) {
      console.error(`Error updating user position:`, error);
    }
  } catch (error) {
    console.error(`Error processing Borrow event:`, error);
  }
});

// Handler for RepayBorrow events
ponder.on("MToken:RepayBorrow", async ({ event, context }) => {
  try {
    const { db } = context;
    const { payer, borrower, repayAmount, accountBorrows, totalBorrows } = event.args;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    const txHash = event.transaction.hash;
    const logIndex = event.log.logIndex;
    
    console.log(`Processing RepayBorrow: payer ${payer} for borrower ${borrower} with amount ${repayAmount}`);

    // 1. Record the transaction
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}`,
        userAddress: borrower, // Track the borrower, not the payer
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "REPAY",
        amount: repayAmount,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
        relatedAddress: payer !== borrower ? payer : null, // Track the payer if different from borrower
      });
    } catch (error) {
      console.error(`Error recording repay transaction:`, error);
    }
    
    // 2. Update user position
    // Get current mToken balance (supply position)
    let supplyBalance = 0n;
    try {
      supplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [borrower],
      });
    } catch (error) {
      console.error(`Error reading balance for ${borrower}:`, error);
    }
    
    // Create position ID
    const positionId = `${borrower}-${M_TOKEN_ETH_ADDRESS}`;
    
    try {
      // Use upsert pattern with the store API
      await db.insert(userPositions)
        .values({
          id: positionId,
          userAddress: borrower,
          mTokenAddress: M_TOKEN_ETH_ADDRESS,
          borrowBalance: accountBorrows,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        })
        .onConflictDoUpdate((row) => ({ 
          borrowBalance: accountBorrows,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        }));
    } catch (error) {
      console.error(`Error updating user position:`, error);
    }
  } catch (error) {
    console.error(`Error processing RepayBorrow event:`, error);
  }
});

// Handler for Mint events
ponder.on("MToken:Mint", async ({ event, context }) => {
  try {
    const { db } = context;
    const { minter, mintAmount, mintTokens } = event.args;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    const txHash = event.transaction.hash;
    const logIndex = event.log.logIndex;
    
    console.log(`Processing Mint: ${minter} with amount ${mintAmount}`);

    // 1. Record the transaction
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}`,
        userAddress: minter,
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "SUPPLY",
        amount: mintAmount,
        tokenAmount: mintTokens,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
      });
    } catch (error) {
      console.error(`Error recording mint transaction:`, error);
    }
    
    // 2. Update user position
    // Get current borrow balance
    let borrowBalance = 0n;
    try {
      borrowBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "borrowBalanceStored",
        args: [minter],
      });
    } catch (error) {
      console.error(`Error reading borrow balance for ${minter}:`, error);
    }
    
    // Get updated supply balance
    let supplyBalance = 0n;
    try {
      supplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [minter],
      });
    } catch (error) {
      console.error(`Error reading supply balance for ${minter}:`, error);
    }
    
    // Create position ID
    const positionId = `${minter}-${M_TOKEN_ETH_ADDRESS}`;
    
    try {
      // Use upsert pattern with the store API
      await db.insert(userPositions)
        .values({
          id: positionId,
          userAddress: minter,
          mTokenAddress: M_TOKEN_ETH_ADDRESS,
          borrowBalance: borrowBalance,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        })
        .onConflictDoUpdate((row) => ({ 
          borrowBalance: borrowBalance,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        }));
    } catch (error) {
      console.error(`Error updating user position:`, error);
    }
  } catch (error) {
    console.error(`Error processing Mint event:`, error);
  }
});

// Handler for Redeem events
ponder.on("MToken:Redeem", async ({ event, context }) => {
  try {
    const { db } = context;
    const { redeemer, redeemAmount, redeemTokens } = event.args;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    const txHash = event.transaction.hash;
    const logIndex = event.log.logIndex;
    
    console.log(`Processing Redeem: ${redeemer} with amount ${redeemAmount}`);

    // 1. Record the transaction
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}`,
        userAddress: redeemer,
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "WITHDRAW",
        amount: redeemAmount,
        tokenAmount: redeemTokens,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
      });
    } catch (error) {
      console.error(`Error recording redeem transaction:`, error);
    }
    
    // 2. Update user position
    // Get current balances
    let borrowBalance = 0n;
    try {
      borrowBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "borrowBalanceStored",
        args: [redeemer],
      });
    } catch (error) {
      console.error(`Error reading borrow balance for ${redeemer}:`, error);
    }
    
    // Get updated supply balance
    let supplyBalance = 0n;
    try {
      supplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [redeemer],
      });
    } catch (error) {
      console.error(`Error reading supply balance for ${redeemer}:`, error);
    }
    
    // Create position ID
    const positionId = `${redeemer}-${M_TOKEN_ETH_ADDRESS}`;
    
    try {
      // Use upsert pattern with the store API
      await db.insert(userPositions)
        .values({
          id: positionId,
          userAddress: redeemer,
          mTokenAddress: M_TOKEN_ETH_ADDRESS,
          borrowBalance: borrowBalance,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        })
        .onConflictDoUpdate((row) => ({ 
          borrowBalance: borrowBalance,
          supplyBalance: supplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        }));
    } catch (error) {
      console.error(`Error updating user position:`, error);
    }
  } catch (error) {
    console.error(`Error processing Redeem event:`, error);
  }
});

// Handler for LiquidateBorrow events
ponder.on("MToken:LiquidateBorrow", async ({ event, context }) => {
  try {
    const { db } = context;
    const { liquidator, borrower, repayAmount, mTokenCollateral, seizeTokens } = event.args;
    const blockNumber = event.block.number;
    const blockTimestamp = event.block.timestamp;
    const txHash = event.transaction.hash;
    const logIndex = event.log.logIndex;
    
    console.log(`Processing Liquidation: liquidator ${liquidator} for borrower ${borrower}`);

    // 1. Record the liquidation transaction for the borrower
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}-borrower`,
        userAddress: borrower,
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "LIQUIDATED",
        amount: repayAmount,
        tokenAmount: seizeTokens,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
        relatedAddress: liquidator,
      });
    } catch (error) {
      console.error(`Error recording liquidation transaction for borrower:`, error);
    }
    
    // 2. Record the liquidation transaction for the liquidator
    try {
      await db.insert(userTransactions).values({
        id: `${txHash}-${logIndex}-liquidator`,
        userAddress: liquidator,
        mTokenAddress: M_TOKEN_ETH_ADDRESS,
        transactionType: "LIQUIDATE",
        amount: repayAmount,
        tokenAmount: seizeTokens,
        blockNumber: BigInt(blockNumber),
        blockTimestamp: BigInt(blockTimestamp),
        transactionHash: txHash,
        relatedAddress: borrower,
      });
    } catch (error) {
      console.error(`Error recording liquidation transaction for liquidator:`, error);
    }
    
    // 3. Update positions for both borrower and liquidator
    // Get current borrow and supply balances for borrower
    let borrowerBorrowBalance = 0n;
    let borrowerSupplyBalance = 0n;
    
    try {
      borrowerBorrowBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "borrowBalanceStored",
        args: [borrower],
      });
      
      borrowerSupplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [borrower],
      });
    } catch (error) {
      console.error(`Error reading balances for borrower ${borrower}:`, error);
    }
    
    // Update borrower position
    const borrowerPositionId = `${borrower}-${M_TOKEN_ETH_ADDRESS}`;
    
    try {
      // Use upsert pattern with the store API for borrower position
      await db.insert(userPositions)
        .values({
          id: borrowerPositionId,
          userAddress: borrower,
          mTokenAddress: M_TOKEN_ETH_ADDRESS,
          borrowBalance: borrowerBorrowBalance,
          supplyBalance: borrowerSupplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        })
        .onConflictDoUpdate((row) => ({ 
          borrowBalance: borrowerBorrowBalance,
          supplyBalance: borrowerSupplyBalance,
          lastUpdatedBlock: BigInt(blockNumber),
          lastUpdatedTimestamp: BigInt(blockTimestamp),
        }));
    } catch (error) {
      console.error(`Error updating borrower position:`, error);
    }
      
    // Update liquidator position if they're using the same market
    // Get current balances for liquidator
    let liquidatorBorrowBalance = 0n;
    let liquidatorSupplyBalance = 0n;
    
    try {
      liquidatorBorrowBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "borrowBalanceStored",
        args: [liquidator],
      });
      
      liquidatorSupplyBalance = await context.client.readContract({
        abi: context.contracts.MToken.abi,
        address: context.contracts.MToken.address,
        functionName: "balanceOf",
        args: [liquidator],
      });
    } catch (error) {
      console.error(`Error reading balances for liquidator ${liquidator}:`, error);
    }
    
    // Only create or update liquidator position if they have a non-zero balance
    if (liquidatorBorrowBalance > 0n || liquidatorSupplyBalance > 0n) {
      // Update liquidator position or create if it doesn't exist
      const liquidatorPositionId = `${liquidator}-${M_TOKEN_ETH_ADDRESS}`;
      
      try {
        // Use upsert pattern with the store API for liquidator position
        await db.insert(userPositions)
          .values({
            id: liquidatorPositionId,
            userAddress: liquidator,
            mTokenAddress: M_TOKEN_ETH_ADDRESS,
            borrowBalance: liquidatorBorrowBalance,
            supplyBalance: liquidatorSupplyBalance,
            lastUpdatedBlock: BigInt(blockNumber),
            lastUpdatedTimestamp: BigInt(blockTimestamp),
          })
          .onConflictDoUpdate((row) => ({ 
            borrowBalance: liquidatorBorrowBalance,
            supplyBalance: liquidatorSupplyBalance,
            lastUpdatedBlock: BigInt(blockNumber),
            lastUpdatedTimestamp: BigInt(blockTimestamp),
          }));
      } catch (error) {
        console.error(`Error updating liquidator position:`, error);
      }
    }
  } catch (error) {
    console.error(`Error processing LiquidateBorrow event:`, error);
  }
}); 