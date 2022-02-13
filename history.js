// this script is used to collect old history data from before the service started monitoring the blocks.

const Web3 = require('web3');
const fs = require('fs');
const db = require('./database');

const args = {
    network: 'ethereum',
};

// sample calls:
// 
// node history.js -n bsc -b 7207183 -s 4 -t 150
// node history.js -n polygon -b 19833528 -s 4 -t 200
// node history.js -n fantom -b 18286418 -s 4 -t 400
// node history.js -n avax -b 33409 -s 4 -t 230
// node history.js -n ethereum -s 4 -t 35 -b 10993996

// receive args
process.argv.forEach((val, index, array) => {
    if ((val == '-n' || val == '--network') && array[index+1]){
        args.network = array[index+1];
    }
    // starting block can be retrieved with etherscan api
    if ((val == '-b' || val == '--starting-block') && array[index+1]){
        args.startingBlock = array[index+1];
    }
    // sample size is how many blocks of data you want to collect between each hop. 4 means for every interval, you will collect 4 blocks.
    if ((val == '-s' || val == '--sample-size') && array[index+1]){
        args.sampleSize = array[index+1];
    }
    // time skip is how many blocks will be your hop. ex 40 means 10 minute intervals for ethereum (15 sec block time)
    if ((val == '-t' || val == '--time-skip') && array[index+1]){
        args.timeSkip = array[index+1];
    }
});


const rpc = {
    last: 0,
    connected: false,
    blocks: {},
    sampleSize: args.sampleSize, // number of samples analized
    startTime: new Date().getTime(),
    scannedBlocks: 0,
    timeSkip: args.timeSkip || 0,

    connect: async function(){
        const url = JSON.parse(fs.readFileSync(`rpcs.json`));

        if (!url[args.network]){
            throw new Error('Network not available');
        }

        console.log('Starting gas oracle...');

        try {
            this.web3 = new Web3(new Web3.providers.HttpProvider(url[args.network || 'ethereum']));
            this.web3.setProvider(url[args.network || 'ethereum']);

            this.last = args.startingBlock ? args.startingBlock : await this.web3.eth.getBlockNumber();

            this.connected = true;
            process.stdout.write(`Connected to ${args.network} RPC.\n`);
        }
        catch(error){
            console.log(error);
            return new Error(error);
        }

        return true;
    },

    getBlock: async function(num) {
        if (!this.connected){
            throw new Error('Not connected');
        }

        try {
            const block = await this.web3.eth.getBlock(num || 'latest', true);
            this.scannedBlocks++;
            return block;
        }
        catch(error){
            // console.log(error);
            return new Error(error);
        }
    },

    loop: async function(){
        try {
            // get a block
            const block = await this.getBlock(this.last);
            if (block && block.transactions){
                // save the block
                this.recordBlock(block);
                // call to update monited wallets. required only if want to monitor txs to target addresses
                // db.updateWallets(block, args.network);
                
                this.last = block.number - parseInt(this.timeSkip / this.sampleSize);
            }
            else {
                this.last = this.last - 1;
            }

            setTimeout(() => this.loop(), 10);
        }
        catch (error){
            console.log(error);
        }
    },

    recordBlock: function(block) {
        // extract the gas from transactions
        const transactions = block.transactions.filter(t => t.gasPrice != '0').map(t => parseFloat(this.web3.utils.fromWei(t.gasPrice, 'gwei'))).sort((a,b) => a - b);
        this.blocks[block.number] = {
            ntx: transactions.length,
            timestamp: block.timestamp,
            minGwei: [],
            avgGas: [],
        };

        if (transactions.length){
            // set average gas per tx in the block
            const avgGas = parseInt(block.gasUsed) / transactions.length;

            this.blocks[block.number].minGwei = transactions;
            this.blocks[block.number].avgGas = avgGas;
        }

        // sort the blocks and discard if higher than sampleSize
        const sortedBlocks = Object.keys(this.blocks).sort((a,b) => parseInt(a) - parseInt(b));
        if (sortedBlocks.length > this.sampleSize){
            delete this.blocks[sortedBlocks[0]];

            const avgTime = ((new Date().getTime() - this.startTime) / this.scannedBlocks).toFixed(1);
            const now = new Date(block.timestamp * 1000).toISOString();
            console.log(`${new Date().toISOString()}: Block: ${this.last}. Avg time: ${avgTime} ms.Timestamp: ${now}.`);

            this.calcBlockStats();
        }
    },

    calcBlockStats: function(){
        // sort blocks by timestamp, then remove blocks with no tx
        const b = Object.values(this.blocks).sort((a,b) => a.timestamp - b.timestamp).filter(e => e.ntx);

        // reshape blocks object to be arrays of each field
        const result = Object.fromEntries(Object.keys(b[0]).map(e => [e, []]));
        b.forEach(block => Object.keys(result).forEach(key => result[key].push(block[key])));

        // last block
        result.lastBlock = this.last;

        fs.writeFileSync(`${__dirname}/history/${args.network}/${this.last}.json`, JSON.stringify(result));
        this.blocks = {};

        return result;
    },
}

rpc.connect().then(() => rpc.loop(), console.log);