const Web3 = require('web3');
const fs = require('fs');

const args = {
    network: 'ethereum',
    sampleSize: 1000,
    timeInterval: 1000,
};

// receive args
process.argv.forEach((val, index, array) => {
    if ((val == '-n' || val == '--network') && array[index+1]){
        args.network = array[index+1];
    }
    if ((val == '-s' || val == '--sample-size') && array[index+1]){
        args.sampleSize = array[index+1];
    }
    if ((val == '-t' || val == '--time-interval') && array[index+1]){
        args.timeInterval = array[index+1];
    }
});


const rpc = {
    last: 0,
    connected: false,
    blocks: {},
    sampleSize: args.sampleSize, // number of samples analized
    timeInterval: args.timeInterval,
    minInterval: 100,
    maxInterval: 15000,

    connect: async function(){

        console.log('Starting gas oracle...');

        try {
            // this.web3 = new Web3(new Web3.providers.HttpProvider(url[args.network]));
            if (!(await this.loadRPC({ first: true }))) {
                throw new Error('Network not available');
            }

            this.last = await this.web3.eth.getBlockNumber();
            this.connected = true;
            process.stdout.write(`Connected to ${args.network} RPC. Fetching ${this.sampleSize} blocks before serving data.\n`);

            if (!(await this.getBaseFee('latest'))){
                this.legacyGas = true;
                console.log('Using legacy gas');
            }
        }
        catch(error){
            console.log(error);
            return new Error(error);
        }

        return this.web3;
    },

    loadRPC: async function({ index=false, first=false }={}) {
        const url = require(`./rpcs.json`);

        // no network, or wrong network passed
        if (!url[args.network]){
            return false;
        }

        // there is only one rpc
        if (!Array.isArray(url[args.network])) {
            url[args.network] = [ url[args.network] ];
        }

        // there is index arg
        if (index) {
            this.web3 = new Web3(url[args.network][index]);
            return true;
        }

        const getBestRPC = async () => {
            // from all rpcs, return last block from all in an object
            const lastBlocks = await Promise.all(url[args.network].map(async rpc => {
                try {
                    const web3 = new Web3(rpc);
                    return { 
                        rpc: rpc,
                        lastBlock: await web3.eth.getBlockNumber(),
                    };
                }
                catch(error) {
                    return {
                        rpc: rpc,
                        error: error,
                    }
                }
            }));
            // console.log(lastBlocks)
            // filter only non-error rpcs
            // sort ascending and get first = best rpc
            return lastBlocks.filter(e => !e.error).sort((a,b) => b.lastBlock - a.lastBlock)[0];
        }

        if (first) {
            const firstRPC = (await Promise.allSettled(url[args.network].map(async rpc => {
                try {
                    const web3 = new Web3(rpc);
                    await web3.eth.getBlock('latest', true);
                    return rpc;
                }
                catch(error) {}
            }))).find(e => e.status == 'fulfilled');
            this.web3 = new Web3(firstRPC.value);
            this.rpc = firstRPC.value;
            return true;
        }

        const loadBestRPC = async () => {
            const bestRPC = await getBestRPC();
            this.web3 = new Web3(bestRPC.rpc);
            this.rpc = bestRPC.rpc;
            this.last = bestRPC.lastBlock;
            this.timeInterval = args.timeInterval;
        }

        // this is the first time run
        if (!this.web3) {
            await loadBestRPC();
            return true;
        }

        // calculate time diff between last reported timestamp and now
        const path = `./blockStats_${args.network}.json`;
        if (!fs.existsSync(path)) {
            fs.writeFileSync(path, JSON.stringify({}));
        }
        const stats = JSON.parse(fs.readFileSync(path));
        const timeDiff = Math.abs(new Date().getTime() / 1000 - stats.lastTime);    
        const timeLimit = 300; // 5 minutes
        if (timeDiff > timeLimit) {
            // console.log(new Date().getTime() / 1000, stats.lastTime);
            await loadBestRPC();
            console.log(`Switching rpc to ${ this.rpc }`);
            return true;
        }

        return false;
    },

    getBlock: async function(num='latest') {
        if (!this.connected){
            throw new Error('Not connected');
        }

        try {
            const block = await this.web3.eth.getBlock(num, true);
            return block;
        }
        catch(error){
            // console.log(error);
            return new Error(error);
        }
    },

    getTx: async function(hash, receipt=false) {
        if (!this.connected){
            throw new Error('Not connected');
        }

        try {
            if (receipt) {
                return await this.web3.eth.getTransactionReceipt(hash);
            }
            return await this.web3.eth.getTransaction(hash);
        }
        catch(error){
            // console.log(error);
            return new Error(error);
        }
    },

    getBaseFee: async function(num='latest') {
        try {
            const history = await this.web3.eth.getFeeHistory(1, num, [0]);
            if (history.baseFeePerGas) {
                return parseInt(history.baseFeePerGas[0]) / 1000000000;
            }
        }
        catch (error) {
            // console.log('Error retieving base gas fee');
            return null;
        }
        return 0;
    },

    loop: async function(){
        try {
            // update scan to last block every 100 blocks
            const toScan = this.last % 100 == 0 ? 'latest' : this.last;
            let promises = [ this.getBlock(toScan) ];

            if (!this.legacyGas) {
                promises.push(this.getBaseFee(toScan));
            }

            promises = await Promise.allSettled(promises);

            const block = promises[0].status == 'fulfilled' ? promises[0].value : null;
            if (!this.legacyGas && block) {
                block.baseFee = promises[1].status == 'fulfilled' ? promises[1].value : null;
            }

            // the rpc does not show block.gasUsed (aurora)
            if (block && block.transactions && block.transactions.length && block.gasUsed == 0) {
                const txs = await Promise.all(block.transactions.map(e => this.getTx(e.hash, true)));
                block.gasUsed = txs.map(e => e.gasUsed).reduce((p,c) => p+c, 0);
            }

            // check if its a new block
            let fetchState = 0;
            let sortedBlocks = Object.keys(this.blocks).sort();
            if (block && block.transactions && block.number >= this.last) {
                // save the block
                await this.recordBlock(block);
                // call to update monited wallets. required only if want to monitor txs to target addresses
                // db.updateWallets(block, args.network);
                this.last = block.number + 1;
                fetchState = 1;
            }
            if (sortedBlocks.length < this.sampleSize && sortedBlocks.length > 0){
                // get block already in the stat file

                let exBlock = this.getExistingBlock(sortedBlocks[0] - 1);
                while (exBlock && sortedBlocks.length < this.sampleSize) {
                    await this.recordBlock(exBlock, true);
                    sortedBlocks = Object.keys(this.blocks).sort();
                    exBlock = this.getExistingBlock(sortedBlocks[0] - 1);
                }

                // there is not a next block yet, fetch a previous block
                const newblock = await this.getBlock(sortedBlocks[0] - 1);
                if (newblock && newblock.transactions) {
                    await this.recordBlock(newblock);
                }

                fetchState = -1;
            }

            if (fetchState == 0) {
                console.log(`Failed to fetch new blocks. I will try again in ${ this.timeInterval.toFixed(1) }ms`);
                await this.loadRPC();
            }

            setTimeout(() => this.loop(), this.dynamicInterval(fetchState));
        }
        catch (error){
            console.log(error);
        }
    },

    extractGasFromBlock: async function(block) {
        // must get gas price differently when L2
        if (args.network == 'arbitrum') {
            const transactions = await Promise.all(block.transactions.filter(t => t.gasPrice && t.gasPrice != '0').map(async tx => {
                // get receipt from tx
                const receipt = await this.getTx(tx.hash, true);
                return {
                    gasPrice: parseFloat(this.web3.utils.fromWei(receipt.effectiveGasPrice.toString(), 'gwei')),
                    gasUsed: parseInt(receipt.gasUsed),
                };
            }).sort((a,b) => a - b));
            return [
                transactions.map(e => e.gasPrice),
                transactions.reduce((p,c) => p + c.gasUsed, 0),
            ]
        }

        return [
            block.transactions.filter(t => t.gasPrice && t.gasPrice != '0').map(t => parseFloat(this.web3.utils.fromWei(t.gasPrice, 'gwei'))).sort((a,b) => a - b),
            parseInt(block.gasUsed),
        ];
    },

    recordBlock: async function(block, cache=false) {
        if (cache) {
            this.blocks[block.number] = {
                ntx: block.ntx,
                timestamp: block.timestamp,
                minGwei: block.minGwei,
                avgGas: block.avgGas,
            };

            if (block.baseFee) {
                this.blocks[block.number].baseFee = block.baseFee;
            }
            console.log(`Block ${block.number} hit cache`);
        }
        else {
            // extract the gas from transactions
            const [ gasPrice, gasUsed ] = await this.extractGasFromBlock(block);
            // console.log(gasPrice, gasUsed);
            this.blocks[block.number] = {
                ntx: gasPrice.length,
                timestamp: block.timestamp,
                minGwei: [],
                avgGas: [],
            };

            if (block.baseFee){
                this.blocks[block.number].baseFee = block.baseFee;
            }

            if (gasPrice.length){
                // set average gas per tx in the block
                this.blocks[block.number].minGwei = gasPrice;
                this.blocks[block.number].avgGas = gasUsed / gasPrice.length;
            }
        }

        // sort the blocks and discard if higher than sampleSize
        const sortedBlocks = Object.keys(this.blocks).sort((a,b) => parseInt(a) - parseInt(b));
        if (sortedBlocks.length > this.sampleSize){
            delete this.blocks[sortedBlocks[0]];

            this.calcBlockStats();
            console.log(`${new Date().toISOString()}: New block ${block.number} read. Next update: ${this.timeInterval.toFixed(1)}ms`);
            // console.log(`Time: elapsed: ${new Date().getTime() - this.time}`);
        }
        else if (!this.warmupCompleted){
            // pretty progress bar
            const barSize = 50;
            const filledBars = parseInt(sortedBlocks.length / this.sampleSize * barSize);
            const barString = [...Array(filledBars).fill('#'), ...Array(barSize - filledBars).fill('=')].join('');
            if (sortedBlocks.length == this.sampleSize){
                const barString = Array(barSize).fill('#').join('');
                console.log(`[${barString}] ${sortedBlocks.length} / ${this.sampleSize}`);
                // process.stdout.write(`\r[${barString}] ${this.sampleSize} / ${this.sampleSize}\n`);
            }
            else{
                console.log(`[${barString}] ${sortedBlocks.length} / ${this.sampleSize}`);
                // process.stdout.write(`\r[${barString}] ${sortedBlocks.length} / ${this.sampleSize}`);
            }

            if (sortedBlocks.length >= this.sampleSize) {
                this.warmupCompleted = true;
            }
        }
    },

    calcBlockStats: function(){
        // sort blocks by timestamp, then remove blocks with no tx
        const b = Object.values(this.blocks).sort((a,b) => a.timestamp - b.timestamp).filter(e => e.ntx);

        if (!b || !b[0]) {
            return false;
        }
        
        // reshape blocks object to be arrays of each field
        const result = Object.fromEntries(Object.keys(b.slice(-1)[0]).map(e => [e, []]));
        b.forEach(block => Object.keys(result).forEach(key => result[key].push(block[key])));

        // last block
        const lastBlock = parseInt(Object.keys(this.blocks).sort((a,b) => parseInt(b) - parseInt(a))[0]);
        result.lastBlock = lastBlock;
        // timestamp from last block
        result.lastTime = this.blocks[lastBlock].timestamp;
        // rpc
        result.rpc = this.rpc;

        fs.writeFileSync(`./blockStats_${args.network}.json`, JSON.stringify(result));
        return result;
    },

    getExistingBlock: function(num) {
        let stats;
        try {
            stats = JSON.parse(fs.readFileSync(`./blockStats_${args.network}.json`));
        }
        catch (error) {
            return false;
        }

        // there is no such block in cache
        if (!stats || !stats.ntx || num <= stats.lastBlock - stats.ntx.length || num > stats.lastBlock){
            return false;
        }

        // get the index to be fetched from the file
        const index = stats.ntx.length - (stats.lastBlock - num) - 1;
        // build a new stats object, where only the index element is present in array values
        const block = Object.fromEntries(Object.keys(stats).filter(e => Array.isArray(stats[e])).map(e => [ e, stats[e][index] ]));
        block.number = num;
        return block;
    },

    dynamicInterval: function(state) {
        const speedFactor = 1.1;
        // not yet started
        if (state === -1) {
            return 10;
        }
        // fetch success
        if (state === 1){
            // increase speed
            this.timeInterval /= speedFactor;
            this.timeInterval = Math.max(this.minInterval, this.timeInterval);
        }
        // fetch fail
        else {
            // reduce speed
            this.timeInterval *= speedFactor;
            this.timeInterval = Math.min(this.maxInterval, this.timeInterval);
        }
    
        return this.timeInterval;
    },
};

rpc.connect().then(async () => {
    rpc.loop();
    // const receipt = await rpc.getTx('0xb02290e8143710cd3f945042a8509edaebf65f0186d54395a722a63e5e8a01d1', true);
    // console.log(receipt);
}, console.log);
