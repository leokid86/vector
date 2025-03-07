import {
  ChannelDispute,
  CoreChannelState,
  CoreTransferState,
  FullChannelState,
  FullTransferState,
  GetTransfersFilterOpts,
  IChainServiceStore,
  IEngineStore,
  ResolveUpdateDetails,
  StoredTransaction,
  StoredTransactionAttempt,
  StoredTransactionReceipt,
  StoredTransactionStatus,
  TransactionReason,
  TransferDispute,
  UpdateType,
  WithdrawCommitmentJson,
} from "@connext/vector-types";
import { TransactionResponse, TransactionReceipt } from "@ethersproject/providers";
import Dexie, { DexieOptions } from "dexie";
import { BaseLogger } from "pino";

type StoredTransfer = FullTransferState & {
  createUpdateNonce: number;
  resolveUpdateNonce: number;
  routingId: string;
  createdAt: Date;
};

const storedTransferToTransferState = (stored: StoredTransfer): FullTransferState => {
  const transfer: any = stored;
  delete transfer.createUpdateNonce;
  delete transfer.resolveUpdateNonce;
  delete transfer.routingId;
  delete transfer.createdAt;
  return transfer as FullTransferState;
};

const getStoreName = (publicIdentifier: string) => {
  return `${publicIdentifier}-store`;
};
const NON_NAMESPACED_STORE = "VectorIndexedDBDatabase";
class VectorIndexedDBDatabase extends Dexie {
  channels: Dexie.Table<FullChannelState, string>;
  transfers: Dexie.Table<StoredTransfer, string>;
  transactions: Dexie.Table<StoredTransaction, string>;
  withdrawCommitment: Dexie.Table<WithdrawCommitmentJson & { transferId: string }, string>;
  channelDisputes: Dexie.Table<
    { channelAddress: string; channelDispute: ChannelDispute; disputedChannel?: CoreChannelState },
    string
  >;
  transferDisputes: Dexie.Table<
    { transferId: string; transferDispute: TransferDispute; disputedTransfer?: CoreTransferState },
    string
  >;
  values: Dexie.Table<any, string>;
  // database name
  name: string;

  constructor(
    name: string,
    // eslint-disable-next-line @typescript-eslint/ban-types
    indexedDB?: { open: Function },
    // eslint-disable-next-line @typescript-eslint/ban-types
    idbKeyRange?: { bound: Function; lowerBound: Function; upperBound: Function },
  ) {
    let options: DexieOptions | undefined;
    if (indexedDB && idbKeyRange) {
      options = { indexedDB, IDBKeyRange: idbKeyRange };
    }
    super(name, options);
    this.version(1).stores({
      channels:
        "channelAddress, [aliceIdentifier+bobIdentifier+networkContext.chainId], [alice+bob+networkContext.chainId]",
      transfers:
        "transferId, [routingId+channelAddress], [createUpdateNonce+channelAddress], [resolveUpdateNonce+channelAddress], [transferResolver+channelAddress]",
      transactions: "transactionHash",
      withdrawCommitment: "transferId",
      values: "key",
    });
    this.version(2)
      .stores({
        channels:
          "channelAddress, [aliceIdentifier+bobIdentifier+networkContext.chainId], [alice+bob+networkContext.chainId], createdAt",
        transfers:
          "transferId, [routingId+channelAddress], [createUpdateNonce+channelAddress], [resolveUpdateNonce+channelAddress], [transferResolver+channelAddress], createdAt, resolveUpdateNonce, channelAddress",
      })
      .upgrade((tx) => {
        // An upgrade function for version 3 will upgrade data based on version 2.
        tx.table("channels")
          .toCollection()
          .modify((channel) => {
            channel.createdAt = new Date();
          });
        tx.table("transfers")
          .toCollection()
          .modify((transfer) => {
            transfer.createdAt = new Date();
          });
      });

    this.version(3).stores({
      withdrawCommitment: "transferId,transactionHash",
    });

    this.version(4).stores({
      channelDisputes: "channelAddress",
      transferDisputes: "transferId",
    });

    // Using a temp table (transactions2) to migrate which column is the primary key
    // (transactionHash -> id)
    this.version(5)
      .stores({
        withdrawCommitment: "transferId,channelAddress,transactionHash",
        transactions2: "id, transactionHash",
      })
      .upgrade(async (tx) => {
        const transactions = await tx.table("transactions").toArray();
        await tx.table("transactions2").bulkAdd(transactions);
      });

    this.version(6).stores({
      transactions: null,
    });

    this.version(7)
      .stores({
        transactions: "id, transactionHash",
      })
      .upgrade(async (tx) => {
        const transactions2 = await tx.table("transactions2").toArray();
        await tx.table("transactions").bulkAdd(transactions2);
      });

    this.version(8).stores({
      transactions2: null,
    });

    this.version(9).stores({
      updates: "id.id, [channelAddress+nonce]",
    });

    this.channels = this.table("channels");
    this.transfers = this.table("transfers");
    this.transactions = this.table("transactions");
    this.withdrawCommitment = this.table("withdrawCommitment");
    this.channelDisputes = this.table("channelDisputes");
    this.transferDisputes = this.table("transferDisputes");
    this.values = this.table("values");
    this.name = name;
  }
}

export class BrowserStore implements IEngineStore, IChainServiceStore {
  private db: VectorIndexedDBDatabase;

  // NOTE: this could be private, but makes it difficult to test because
  // you can't mock the `Dexie.exists` call used in the static `create`
  // function. However, the constructor should *not* be used when creating
  // an instance of the BrowserStore
  constructor(
    private readonly dbName: string,
    private readonly log: BaseLogger,
    // eslint-disable-next-line @typescript-eslint/ban-types
    indexedDB?: { open: Function },
    // eslint-disable-next-line @typescript-eslint/ban-types
    idbKeyRange?: { bound: Function; lowerBound: Function; upperBound: Function },
  ) {
    this.db = new VectorIndexedDBDatabase(dbName, indexedDB, idbKeyRange);
  }

  public static async create(
    publicIdentifer: string,
    log: BaseLogger,
    // eslint-disable-next-line @typescript-eslint/ban-types
    indexedDB?: { open: Function },
    // eslint-disable-next-line @typescript-eslint/ban-types
    idbKeyRange?: { bound: Function; lowerBound: Function; upperBound: Function },
  ): Promise<BrowserStore> {
    const name = (await Dexie.exists(NON_NAMESPACED_STORE)) ? NON_NAMESPACED_STORE : getStoreName(publicIdentifer);
    const store = new BrowserStore(name, log, indexedDB, idbKeyRange);
    await store.connect();
    return store;
  }

  public async connect(): Promise<void> {
    await this.db.open();
  }

  disconnect(): Promise<void> {
    return Promise.resolve(this.db.close());
  }

  getSchemaVersion(): Promise<number | undefined> {
    return Promise.resolve(1);
  }

  updateSchemaVersion(version?: number): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async clear(): Promise<void> {
    await this.db.channels.clear();
    await this.db.transfers.clear();
    await this.db.transactions.clear();
  }

  // TODO (@jakekidd): Does this belong in utils somewhere? I believe it's only use case is here.
  /// Santitize TransactionReceipt for input as StoredTransactionReceipt.
  private sanitizeReceipt(receipt: TransactionReceipt): StoredTransactionReceipt {
    return {
      transactionHash: receipt.transactionHash,
      contractAddress: receipt.contractAddress,
      transactionIndex: receipt.transactionIndex,
      root: receipt.root,
      gasUsed: receipt.gasUsed.toString(),
      cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
      logsBloom: receipt.logsBloom,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      logs: receipt.logs.toString(),
      byzantium: receipt.byzantium,
      status: receipt.status,
    } as StoredTransactionReceipt;
  }

  async saveChannelStateAndTransfers(
    channelState: FullChannelState,
    activeTransfers: FullTransferState[],
  ): Promise<void> {
    await this.db.transaction("rw", this.db.channels, this.db.transfers, async () => {
      // remove all "active" transfers
      const currActive = await this.getActiveTransfers(channelState.channelAddress);
      // TODO: can we "unassociate" them without deleting them? GH #431
      await this.db.transfers.bulkDelete(currActive.map((t) => t.transferId));
      // save channel
      await this.db.channels.put(channelState);
      // save all active transfers
      await this.db.transfers.bulkPut(
        activeTransfers.map((transfer) => {
          return {
            ...transfer,
            createUpdateNonce: transfer.channelNonce + 1,
            resolveUpdateNonce: 0,
            routingId: transfer?.meta?.routingId,
            createdAt: new Date(),
          };
        }),
      );
    });
  }

  async saveChannelState(channelState: FullChannelState, transfer?: FullTransferState): Promise<void> {
    await this.db.transaction("rw", this.db.channels, this.db.transfers, async () => {
      await this.db.channels.put(channelState);
      if (channelState.latestUpdate.type === UpdateType.create) {
        await this.db.transfers.put({
          ...transfer!,
          createUpdateNonce: channelState.latestUpdate.nonce,
          resolveUpdateNonce: 0,
          routingId: transfer?.meta?.routingId, // allow indexing on routingId
          createdAt: new Date(),
        });
      } else if (channelState.latestUpdate.type === UpdateType.resolve) {
        await this.db.transfers.update((channelState.latestUpdate.details as ResolveUpdateDetails).transferId, {
          resolveUpdateNonce: channelState.latestUpdate.nonce,
          transferResolver: (channelState.latestUpdate.details as ResolveUpdateDetails).transferResolver,
        } as Partial<StoredTransfer>);
      }
    });
  }

  async getChannelStates(): Promise<FullChannelState[]> {
    const channels = await this.db.channels.toArray();
    return channels;
  }

  async getChannelState(channelAddress: string): Promise<FullChannelState | undefined> {
    const channel = await this.db.channels.get(channelAddress);
    return channel;
  }

  async getChannelStateByParticipants(
    publicIdentifierA: string,
    publicIdentifierB: string,
    chainId: number,
  ): Promise<FullChannelState | undefined> {
    const channel = await this.db.channels
      .where("[aliceIdentifier+bobIdentifier+networkContext.chainId]")
      .equals([publicIdentifierA, publicIdentifierB, chainId])
      .or("[aliceIdentifier+bobIdentifier+networkContext.chainId]")
      .equals([publicIdentifierB, publicIdentifierA, chainId])
      .first();
    return channel;
  }

  async getActiveTransfers(channelAddress: string): Promise<FullTransferState[]> {
    const collection = this.db.transfers.where("[resolveUpdateNonce+channelAddress]").equals([0, channelAddress]);
    const transfers = await collection.toArray();
    return transfers.map(storedTransferToTransferState);
  }

  async getTransferState(transferId: string): Promise<FullTransferState | undefined> {
    const transfer = await this.db.transfers.get(transferId);
    return transfer ? storedTransferToTransferState(transfer) : undefined;
  }

  async getTransferByRoutingId(channelAddress: string, routingId: string): Promise<FullTransferState | undefined> {
    const transfer = await this.db.transfers.get({ channelAddress, routingId });
    return transfer ? storedTransferToTransferState(transfer) : undefined;
  }

  async getTransfersByRoutingId(routingId: string): Promise<FullTransferState[]> {
    const transfers = this.db.transfers.where({ routingId });
    const ret = await transfers.toArray();
    return ret.map(storedTransferToTransferState);
  }

  async getTransfers(filterOpts?: GetTransfersFilterOpts): Promise<FullTransferState[]> {
    const filterQuery: any = [];
    if (filterOpts?.channelAddress) {
      filterQuery.push({ index: "channelAddress", function: "equals", params: filterOpts.channelAddress });
    }

    // start and end
    if (filterOpts?.startDate && filterOpts.endDate) {
      filterQuery.push({ index: "channelAddress", function: "between", params: filterOpts.channelAddress });
    } else if (filterOpts?.startDate) {
      filterQuery.push({ index: "channelAddress", function: "equals", params: filterOpts.channelAddress });
    } else if (filterOpts?.endDate) {
      filterQuery.push({ index: "channelAddress", function: "equals", params: filterOpts.channelAddress });
    }

    let collection = this.db.transfers.toCollection();
    if (filterOpts?.channelAddress) {
      collection = collection.filter((transfer) => transfer.channelAddress === filterOpts.channelAddress);
    }
    if (filterOpts?.startDate && filterOpts.endDate) {
      collection = collection.filter(
        (transfer) => transfer.createdAt >= filterOpts.startDate! && transfer.createdAt <= filterOpts.endDate!,
      );
    } else if (filterOpts?.startDate) {
      collection = collection.filter((transfer) => transfer.createdAt >= filterOpts.startDate!);
    } else if (filterOpts?.endDate) {
      collection = collection.filter((transfer) => transfer.createdAt <= filterOpts.endDate!);
    }

    if (filterOpts?.active) {
      collection = collection.filter((transfer) => transfer.resolveUpdateNonce === 0);
    }

    if (filterOpts?.routingId) {
      collection = collection.filter((transfer) => transfer.routingId === filterOpts.routingId);
    }

    if (filterOpts?.transferDefinition) {
      collection = collection.filter((transfer) => transfer.transferDefinition === filterOpts.transferDefinition);
    }

    const transfers = await collection.toArray();
    return transfers.map(storedTransferToTransferState);
  }

  async getTransactionById(onchainTransactionId: string): Promise<StoredTransaction | undefined> {
    return await this.db.transactions.get({ id: onchainTransactionId });
  }

  async getActiveTransactions(): Promise<StoredTransaction[]> {
    const tx = await this.db.transactions
      .filter((tx) => {
        return !tx.receipt && tx.status === StoredTransactionStatus.submitted;
      })
      .toArray();
    return tx;
  }

  async saveTransactionAttempt(
    onchainTransactionId: string,
    channelAddress: string,
    reason: TransactionReason,
    response: TransactionResponse,
  ): Promise<void> {
    // Populate nested attempts array.
    let attempts: StoredTransactionAttempt[] = [];
    const res = await this.db.transactions.where(":id").equals(onchainTransactionId).first();
    if (res) {
      attempts = Array.from(res.attempts);
    }
    attempts.push({
      // TransactionResponse fields (defined when submitted)
      gasLimit: response.gasLimit.toString(),
      gasPrice: response.gasPrice.toString(),
      transactionHash: response.hash,

      createdAt: new Date(),
    } as StoredTransactionAttempt);

    await this.db.transactions.put(
      {
        id: onchainTransactionId,

        //// Helper fields
        channelAddress,
        status: StoredTransactionStatus.submitted,
        reason,

        //// Provider fields
        // Minimum fields (should always be defined)
        to: response.to!,
        from: response.from,
        data: response.data,
        value: response.value.toString(),
        chainId: response.chainId,
        nonce: response.nonce,
        attempts,
      } as StoredTransaction,
      onchainTransactionId,
    );
  }

  async saveTransactionReceipt(onchainTransactionId: string, receipt: TransactionReceipt): Promise<void> {
    await this.db.transactions.update(onchainTransactionId, {
      status: StoredTransactionStatus.mined,
      receipt: this.sanitizeReceipt(receipt),
    });
  }

  async saveTransactionFailure(
    onchainTransactionId: string,
    error: string,
    receipt?: TransactionReceipt,
  ): Promise<void> {
    await this.db.transactions.update(onchainTransactionId, {
      status: StoredTransactionStatus.failed,
      error,
      receipt: receipt ? this.sanitizeReceipt(receipt) : undefined,
    });
  }

  async getTransactionByHash(transactionHash: string): Promise<StoredTransaction | undefined> {
    const tx = await this.db.transactions.get(transactionHash);
    return tx;
  }

  async saveWithdrawalCommitment(transferId: string, withdrawCommitment: WithdrawCommitmentJson): Promise<void> {
    await this.db.withdrawCommitment.put({ ...withdrawCommitment, transferId });
  }

  async getWithdrawalCommitment(transferId: string): Promise<WithdrawCommitmentJson | undefined> {
    const w = await this.db.withdrawCommitment.get(transferId);
    if (!w) {
      return w;
    }
    const { transferId: t, ...commitment } = w;
    return commitment;
  }

  async getWithdrawalCommitmentByTransactionHash(transactionHash: string): Promise<WithdrawCommitmentJson | undefined> {
    const w = await this.db.withdrawCommitment.get({ transactionHash });
    if (!w) {
      return w;
    }
    const { transferId, ...commitment } = w;
    return commitment;
  }

  // TOOD: dont really need this yet, but prob will soon
  getUnsubmittedWithdrawals(
    channelAddress: string,
    withdrawalDefinition: string,
  ): Promise<
    {
      commitment: WithdrawCommitmentJson; // function. However, the constructor should *not* be used when creating
      // function. However, the constructor should *not* be used when creating
      // an instance of the BrowserStore
      transfer: FullTransferState<any>;
    }[]
  > {
    throw new Error("Method not implemented.");
  }

  async saveTransferDispute(
    transferId: string,
    transferDispute: TransferDispute,
    disputedTransfer?: CoreTransferState,
  ): Promise<void> {
    await this.db.transferDisputes.put({ transferDispute, transferId, disputedTransfer });
  }

  async getTransferDispute(transferId: string): Promise<TransferDispute | undefined> {
    const entity = await this.db.transferDisputes.get({ transferId });
    if (!entity) {
      return undefined;
    }
    return entity.transferDispute;
  }

  async saveChannelDispute(
    channelAddress: string,
    channelDispute: ChannelDispute,
    disputedChannel?: CoreChannelState,
  ): Promise<void> {
    await this.db.channelDisputes.put({ channelDispute, disputedChannel, channelAddress });
  }

  async getChannelDispute(channelAddress: string): Promise<ChannelDispute | undefined> {
    const entity = await this.db.channelDisputes.get({ channelAddress });
    if (!entity) {
      return undefined;
    }
    return entity.channelDispute;
  }
}
