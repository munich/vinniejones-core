const Sequelize = require('sequelize')
const Block = requireFrom('model/block')
const Transaction = requireFrom('model/transaction')
const config = requireFrom('core/config')
const logger = requireFrom('core/logger')
const schema = require('./schema')
const DBInterface = requireFrom('core/dbinterface')

module.exports = class SequelizeDB extends DBInterface {
  init (params) {
    if (this.db) {
      return Promise.reject(new Error('Already initialised'))
    }
    this.db = new Sequelize(params.uri, {
      dialect: params.dialect,
      logging: !!params.logging,
      operatorsAliases: Sequelize.Op
    })
    return this.db
      .authenticate()
      .then(() => schema.syncTables(this.db))
      .then(tables => ([this.blocksTable, this.transactionsTable, this.walletsTable, this.roundsTable] = tables))
  }

  getActiveDelegates (height) {
    const activeDelegates = config.getConstants(height).activeDelegates
    const round = ~~(height / activeDelegates)
    if (this.activedelegates && this.activedelegates.length && this.activedelegates[0].round === round) return Promise.resolve(this.activedelegates)
    else {
      return this.roundsTable
        .findAll({
          where: {
            round: round
          },
          order: [[ 'publicKey', 'ASC' ]]
        })
        .then(data => data.map(a => a.dataValues).sort((a, b) => b.balance - a.balance))
    }
  }

  deleteRound (round) {
    return this.roundsTable
      .destroy({
        where: {
          round: round
        }
      })
  }

  buildDelegates (block) {
    const activeDelegates = config.getConstants(block.data.height).activeDelegates
    const that = this
    return this.walletsTable
      .findAll({
        attributes: [
          ['vote', 'publicKey'],
          [Sequelize.fn('SUM', Sequelize.col('balance')), 'balance']
        ],
        group: 'vote',
        where: {
          vote: {
            [Sequelize.Op.ne]: null
          }
        }
      })
      .then(data => {
        if (data.length < activeDelegates) {
          return this.walletsTable
            .findAll({
              attributes: [
                'publicKey'
              ],
              where: {
                username: {
                  [Sequelize.Op.ne]: null
                }
              },
              order: [[ 'publicKey', 'ASC' ]],
              limit: activeDelegates - data.length
            })
            .then((data2) => data.concat(data2))
        } else return Promise.resolve(data)
      })
      .then(data => {
        // logger.info(`got ${data.length} voted delegates`)
        const round = parseInt(block.data.height / 51)
        that.activedelegates = data
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 51)
          .map(a => ({...{round: round}, ...a.dataValues}))
        logger.debug(`generated ${that.activedelegates.length} active delegates`)
        return Promise.resolve(that.activedelegates)
      })
  }

  buildWallets () {
    this.walletManager.reset()
    logger.printTracker('SPV Building', 0, 7)
    return this.transactionsTable
      .findAll({
        attributes: [
          'recipientId',
          [Sequelize.fn('SUM', Sequelize.col('amount')), 'amount']
        ],
        where: {type: 0},
        group: 'recipientId'
      })
      .then(data => {
        logger.printTracker('SPV Building', 1, 7, 'received transactions')
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByAddress(row.recipientId)
          wallet.balance = parseInt(row.amount)
        })
        return this.db.query('select `generatorPublicKey`, sum(`reward`+`totalFee`) as reward, count(*) as produced from blocks group by `generatorPublicKey`', {type: Sequelize.QueryTypes.SELECT})
      })
      .then(data => {
        logger.printTracker('SPV Building', 2, 7, 'block rewards')
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByPublicKey(row.generatorPublicKey)
          wallet.balance += parseInt(row.reward)
          wallet.producedBlocks += parseInt(row.produced)
        })
        return this.transactionsTable.findAll({
          attributes: [
            'senderPublicKey',
            [Sequelize.fn('SUM', Sequelize.col('amount')), 'amount'],
            [Sequelize.fn('SUM', Sequelize.col('fee')), 'fee']
          ],
          group: 'senderPublicKey'
        })
      })
      .then(data => {
        logger.printTracker('SPV Building', 3, 7, 'sent transactions')
        data.forEach(row => {
          let wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
          wallet.balance -= parseInt(row.amount) + parseInt(row.fee)
          if (wallet.balance < 0) {
            logger.warn('Negative balance should never happen except from premining address:')
            logger.warn(wallet)
          }
        })
        return this.transactionsTable.findAll({
          attributes: [
            'senderPublicKey',
            'serialized'
          ],
          where: {type: 1}}
        )
      })
      .then(data => {
        logger.printTracker('SPV Building', 4, 7, 'second signatures')
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
          wallet.secondPublicKey = Transaction.deserialize(row.serialized.toString('hex')).asset.signature.publicKey
        })
        return this.transactionsTable.findAll({
          attributes: [
            'senderPublicKey',
            'serialized'
          ],
          where: {type: 2}}
        )
      })
      .then(data => {
        logger.printTracker('SPV Building', 5, 7, 'delegates')
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
          wallet.username = Transaction.deserialize(row.serialized.toString('hex')).asset.delegate.username
          this.walletManager.updateWallet(wallet)
        })
        Object.values(this.walletManager.walletsByAddress)
          .filter(a => a.balance < 0)
          .forEach(a => logger.debug(a))
        return this.transactionsTable.findAll({
          attributes: [
            'senderPublicKey',
            'serialized'
          ],
          order: [[ 'createdAt', 'DESC' ]],
          where: {type: 3}}
        )
      })
      .then(data => {
        logger.printTracker('SPV Building', 6, 7, 'votes')
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
          if (!wallet.voted) {
            let vote = Transaction.deserialize(row.serialized.toString('hex')).asset.votes[0]
            if (vote.startsWith('+')) wallet.vote = vote.slice(1)
            wallet.voted = true
          }
        })
        logger.printTracker('SPV Building', 7, 7, 'multisignatures')
        return this.transactionsTable.findAll({
          attributes: [
            'senderPublicKey',
            'serialized'
          ],
          order: [[ 'createdAt', 'DESC' ]],
          where: {type: 4}}
        )
      })
      .then(data => {
        data.forEach(row => {
          const wallet = this.walletManager.getWalletByPublicKey(row.senderPublicKey)
          wallet.multisignature = Transaction.deserialize(row.serialized.toString('hex')).asset.multisignature
        })
        logger.info('SPV rebuild finished, wallets in memory:', Object.keys(this.walletManager.walletsByAddress).length)
        logger.info(`Number of registered delegates: ${Object.keys(this.walletManager.delegatesByUsername).length}`)
        return Promise.resolve(this.walletManager.walletsByAddress || [])
      })
      .catch(error => logger.error(error))
  }

  saveWallets (force) {
    return this.db
      .transaction(t =>
        Promise.all(
          Object.values(this.walletManager.walletsByPublicKey || {})
            // cold addresses are not saved on database
            .filter(acc => acc.publicKey && (force || acc.dirty))
            .map(acc => this.walletsTable.upsert(acc, {transaction: t}))
        )
      )
      .then(() => logger.info('Rebuilt wallets saved'))
      .then(() => Object.values(this.walletManager.walletsByAddress).forEach(acc => (acc.dirty = false)))
  }

  saveBlock (block) {
    return this.db.transaction(t =>
      this.blocksTable
        .create(block.data, {transaction: t})
        .then(() => this.transactionsTable.bulkCreate(block.transactions || [], {transaction: t}))
    )
  }

  deleteBlock (block) {
    return this.db.transaction(t =>
      this.transactionsTable
        .destroy({where: {blockId: block.data.id}}, {transaction: t})
        .then(() => this.blocksTable.destroy({where: {id: block.data.id}}, {transaction: t}))
    )
  }

  getBlock (id) {
    return this.blocksTable
      .findOne({
        include: [{
          model: this.transactionsTable,
          attributes: ['serialized']
        }],
        attributes: {
          exclude: ['createdAt', 'updatedAt']
        },
        where: {
          id: id
        }
      })
      .then((block) =>
        this.transactionsTable
          .findAll({where: {blockId: block.id}})
          .then(data => {
            block.transactions = data.map(tx => Transaction.deserialize(tx.serialized.toString('hex')))
            return Promise.resolve(new Block(block))
          })
      )
  }

  getCommonBlock (ids) {
    return this.db.query(`SELECT MAX("height") AS "height", "id", "previousBlock", "timestamp" FROM blocks WHERE "id" IN ('${ids.join('\',\'')}') GROUP BY "id" ORDER BY "height" DESC`, {type: Sequelize.QueryTypes.SELECT})
  }

  getTransactionsFromIds (txids) {
    return this.db.query(`SELECT serialized FROM transactions WHERE id IN ('${txids.join('\',\'')}')`, {type: Sequelize.QueryTypes.SELECT})
      .then(rows => rows.map(row => Transaction.deserialize(row.serialized.toString('hex'))))
      .then(transactions => txids.map((tx, i) => (txids[i] = transactions.find(tx2 => tx2.id === txids[i]))))
  }

  getLastBlock () {
    return this.blocksTable
      .findOne({order: [['height', 'DESC']]})
      .then(data => { // TODO to remove as it would fail anyway next in the pipeline?
        if (data) {
          return Promise.resolve(data)
        } else {
          return Promise.reject(new Error('No block found in database'))
        }
      })
      .then((block) =>
        this.transactionsTable
          .findAll({where: {blockId: block.id}})
          .then(data => {
            block.transactions = data.map(tx => Transaction.deserialize(tx.serialized.toString('hex')))
            return Promise.resolve(new Block(block))
          })
      )
  }

  getBlocks (offset, limit) {
    const last = offset + limit
    return this.blocksTable
      .findAll({
        include: [{
          model: this.transactionsTable,
          attributes: ['serialized']
        }],
        attributes: {
          exclude: ['createdAt', 'updatedAt']
        },
        where: {
          height: {
            [Sequelize.Op.between]: [offset, last]
          }
        }
      })
      .then(blocks => {
        const nblocks = blocks.map(block => {
          block.dataValues.transactions = block.dataValues.transactions.map(tx => tx.serialized.toString('hex'))
          return block.dataValues
        })
        return Promise.resolve(nblocks)
      })
  }

  getBlockHeaders (offset, limit) {
    const last = offset + limit
    return this.blocksTable
      .findAll({
        attributes: {
          exclude: ['createdAt', 'updatedAt']
        },
        where: {
          height: {
            [Sequelize.Op.between]: [offset, last]
          }
        }
      })
      .then(blocks => blocks.map(block => Block.serialize(block)))
  }
}
