import {
    bytifyRawString,
    calculateFee,
    createSpore,
    payFeeThroughCollection,
    predefinedSporeConfigs
} from '@spore-sdk/core';
import {createDefaultLockWallet, fetchLocalFile} from './helpers';
import {ALICE} from "./test-keys";
import {Hash, utils} from "@ckb-lumos/base";
import {BI, Cell, CellDep, commons, helpers, Indexer, RPC, Script} from "@ckb-lumos/lumos";
import {bytes} from "@ckb-lumos/lumos/codec";
import {common} from '@ckb-lumos/lumos/common-scripts';
import {bytify} from "@ckb-lumos/codec/lib/bytes";
import * as constants from "constants";
import { waitForTransaction } from '@spore-sdk/core';


// Demo
const wallet = createDefaultLockWallet(ALICE.PRIVATE_KEY);
const indexer = new Indexer(predefinedSporeConfigs.Testnet.ckbIndexerUrl);
const rpc = new RPC(predefinedSporeConfigs.Testnet.ckbNodeUrl);
const BindingLifecycleTypeHash : Hash = '0x20f1117a520a066fa9bf99ace508226b8706d559270c35c81403e057ccdc583d';
const BindingLifecycleCellDep: CellDep = {
    outPoint: {
        txHash: '0x1d1dd7e545de483e098c818d61d9a6a711b7e8a028c196908daee2bbcafa34a8',
        index: '0x0',
    },
    depType:  "code",
}
const segmentSize = 100; // 100b

function trim0x(input: string): string {
    if (input.startsWith("0x")) {
        return input.slice(2);
    }
    return input;
}

function stringToHex(str: string): string {
    str = trim0x(str);

    let hex: string = '';
    for (let i = 0; i < str.length; i++) {
        hex += str.charCodeAt(i).toString(16);
    }
    return hex;
}


async function mintSpore(contentType: string, contentHash: Hash) {
    const {txSkeleton, outputIndex} = await createSpore({
        data: {
            contentType,
            content: contentHash,
        },
        toLock: wallet.lock,
        fromInfos: [wallet.address],
    });

    const txHash = await wallet.signAndSendTransaction(txSkeleton);
    const sporeID = txSkeleton.get('outputs').get(outputIndex)!.cellOutput.type!.args
    const typeHash = utils.computeScriptHash(txSkeleton.get('outputs').get(outputIndex)!.cellOutput.type!)

    const txStatus = await waitForTransaction(txHash, rpc);
    if (txStatus.txStatus.status != "committed") {
        throw new Error("Failed to mint Spore Cell, txStatus: " + JSON.stringify(txStatus));
    }

    console.log(`Spore created at: https://pudge.explorer.nervos.org/transaction/${txHash}`);
    console.log(`Spore created at: https://a-simple-demo.spore.pro/spore/${sporeID}`);
    console.log(`Spore's Type Hash: ${typeHash}`);

    return {sporeID: sporeID, typeHash: typeHash};
}

async function mintSporeSegment(sporeTypeHash: Hash, segmentContent: Uint8Array) {
    let txSkeleton = helpers.TransactionSkeleton({ cellProvider: indexer });

    // Build Spore Segment Cell's lock script
    // Build Spore Segment Cell
    const sporeSegmentLockScript: Script = {
        codeHash: BindingLifecycleTypeHash,
        hashType: 'type',
        args: sporeTypeHash,
    };
    const sporeSegmentOutput: Cell = {
        cellOutput: {
            capacity: "0x0",
            lock: sporeSegmentLockScript,
        },
        data: bytes.hexify(segmentContent),
    };

    // Fill the Spore Segment Cell's occupied capacity
    const occupiedCapacity = helpers.minimalCellCapacityCompatible(sporeSegmentOutput);
    sporeSegmentOutput.cellOutput.capacity = "0x" + occupiedCapacity.toString(16);

    // Build the transaction:
    //   - outputs[0]: Spore Segment Cell
    //   - cellDeps[0]: BindingLifecycleCellDep
    //   - cellDeps[1]: SECP256K1_BLAKE160
    txSkeleton = txSkeleton.update("outputs", (outputs) => outputs.push(sporeSegmentOutput));
    txSkeleton = txSkeleton.update("cellDeps", (cellDeps) => cellDeps.push(BindingLifecycleCellDep) );
    txSkeleton = txSkeleton.update("cellDeps", (cellDeps) =>
        cellDeps.push({
            outPoint: {
                txHash: predefinedSporeConfigs.Testnet.lumos.SCRIPTS.SECP256K1_BLAKE160.TX_HASH,
                index: predefinedSporeConfigs.Testnet.lumos.SCRIPTS.SECP256K1_BLAKE160.INDEX,
            },
            depType: predefinedSporeConfigs.Testnet.lumos.SCRIPTS.SECP256K1_BLAKE160.DEP_TYPE,
        })
    );

    // TODO: calculateFee requires the transaction size as the first parameter, I mock it with 2 * occupiedCapacity
    // for PoC only.
    const amount = calculateFee( 2 * occupiedCapacity.toNumber(), BI.from(1000n));
    txSkeleton = common.prepareSigningEntries( txSkeleton);
    txSkeleton = await common.injectCapacity(
        txSkeleton,
        [ wallet.address ],
        amount,
        wallet.address,
        undefined,
        {
            config: predefinedSporeConfigs.Testnet.lumos,
        }
    );

    const txHash = await wallet.signAndSendTransaction(txSkeleton);
    const txStatus = await waitForTransaction(txHash, rpc);
    if (txStatus.txStatus.status != "committed") {
        throw new Error("Failed to mint Spore Cell, txStatus: " + JSON.stringify(txStatus));
    }

    console.log(`Spore Segment created at: https://pudge.explorer.nervos.org/transaction/${txHash}`);
}

async function main() {
    if (process.argv.length < 3) {
        throw new Error("Please provide the operation as the first argument, 'mint', 'transfer', 'melt'");
    }

    // The arguments:
    //   - 1st argument indicates the operation, "mint", "transfer", "melt"
    //   - for "mint" operation, the 2nd argument is the file path of the video segment
    //   - for "transfer" operation, the 2nd argument is the Spore ID, the 3rd argument is the recipient address
    //   - for "melt" operation, the 2nd argument is the Spore ID
    const operation = process.argv[2];
    if (operation == "mint") {
        if (process.argv.length < 4) {
            throw new Error("Please provide the file path to mint Spore");
        }

        const segmentFile = process.argv[3];

        // Mint Spore Cell
        const contentHash = await computeFileHash(segmentFile);
        const { typeHash } = await mintSpore('video/mp4+spore', contentHash);

        // Mint Spore Segment Cells
        const segments = await splitFileIntoSegments(segmentFile, segmentSize);
        for (const segment of segments) {
            await mintSporeSegment(typeHash, segment);
        }
    } else {
        throw new Error("unsupported operation, only support 'mint', 'transfer', 'melt' now.");
    }
}

async function computeFileHash(filePath: string) : Promise<Hash> {
    return await fetchLocalFile(filePath).then((fileContent) => {
        return utils.ckbHash(fileContent);
    });
}

async function splitFileIntoSegments(filePath: string, segmentSize: number) : Promise<Uint8Array[]>{
    return await fetchLocalFile(filePath).then((fileContent) => {
        const fileContentLength = fileContent.length;
        const segmentCount = Math.ceil(fileContentLength / segmentSize);

        let segments: Uint8Array[] = [];
        for (let i = 0; i < segmentCount; i++) {
            const segmentContent = fileContent.slice(i * segmentSize, (i + 1) * segmentSize);

            // Build the segment content with index: [segmentIndex :: u8, segmentContent]
            const segmentIndex = new Uint8Array([i]);
            const segmentContentWithIndex = new Uint8Array(segmentIndex.length + segmentContent.length);
            segmentContentWithIndex.set(segmentIndex, 0);
            segmentContentWithIndex.set(segmentContent, segmentIndex.length);

            segments.push(segmentContentWithIndex);
        }
        return segments;
    });
}

main();
