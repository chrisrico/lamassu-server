const db = require('./db')
const uuid = require('uuid')
const _ = require('lodash/fp')
const BN = require('./bn')
const anonymous = require('../lib/constants').anonymousCustomer
const NUM_RESULTS = 20
const camelize = require('camelize')
const Pgp = require('pg-promise')()
const complianceOverrides = require('./compliance_overrides')

function add (customer) {
  const sql = 'insert into customers (id, phone, phone_at) values ($1, $2, now()) returning *'
  return db.one(sql, [uuid.v4(), customer.phone])
}

function get (phone) {
  const sql = 'select id, phone from customers where phone=$1'
  return db.oneOrNone(sql, [phone])
  .then(customer => {
    if (!customer) return
    return getDailyVolume(customer.id).then(dailyVolume => {
      return _.set('dailyVolume', dailyVolume, customer)
    })
  })
}

/**
 * Update customer record
 *
 * @name update
 * @function
 *
 * @param {string} id Customer's id
 * @param {object} data Fields to update
 * @param {string} Acting user's token
 *
 * @returns {Promise} Newly updated Customer
 */
function update (id, data, userToken) {
  const formattedData = _.omit(['id'], _.mapKeys(_.snakeCase, data))
  const updateData = addOverrideUser(formattedData, userToken)
  addComplianceOverrides(id, updateData, userToken)
  const sql = Pgp.helpers.update(updateData, _.keys(updateData), 'customers') +
    ' where id=$1 returning *'
  return db.one(sql, [id])
  .then(customer => customer ? format(customer) : null)
}

function getById (id) {
  const sql = 'select * from customers where id=$1'
  return db.oneOrNone(sql, [id])
  .then(customer => customer ? format(customer) : null)
}

function getDailyVolume (id) {
  return Promise.all([
    db.one(`select coalesce(sum(fiat), 0) as total from cash_in_txs 
           where customer_id=$1 
           and created > now() - interval '1 day'`, [id]),
    db.one(`select coalesce(sum(fiat), 0) as total from cash_out_txs 
           where customer_id=$1 
           and created > now() - interval '1 day'`, [id])
  ]).then(([cashInTotal, cashOutTotal]) => {
    return BN(cashInTotal.total).add(cashOutTotal.total)
  })
}

/**
 * Add *override_by fields with acting user's token
 *
 * @name addOverrideUser
 * @function
 *
 * @param {object} customer Customer's object to add the fields
 * @param {string} userToken Acting user's token
 * @returns {object} Customer populated with *_by fields
 */
function addOverrideUser (customer, userToken) {
  if (!userToken) return customer
  // Overrode fields
  const overrideFields = [
    'sms_override',
    'id_card_data_override',
    'id_card_photo_override',
    'front_facing_cam_override',
    'sanctions_check_override',
    'authorized_override' ]
  overrideFields.forEach(field => {
    if (customer[field]) customer[field + '_by'] = userToken
  })
  return customer
}

/**
 * Save new compliance override records
 *
 * Take the override fields that are modified in customer and create
 * a compliance override record in db for each compliance type.
 *
 * @name addComplianceOverrides
 * @function
 *
 * @param {string} id Customer's id
 * @param {object} customer Customer that is updating
 * @param {string} userToken Acting user's token
 *
 * @returns {promise} Result from compliance_overrides creation
 */
function addComplianceOverrides (id, customer, userToken) {
  // Compliance override field mappings
  const overrideFields = [{
    name: 'sms_override',
    complianceType: 'sms'
  }, {
    name: 'id_card_data_override',
    complianceType: 'id_card_data'
  }, {
    name: 'id_card_photo_override',
    complianceType: 'id_card_photo'
  }, {
    name: 'front_facing_cam_override',
    complianceType: 'front_camera'
  }, {
    name: 'sanctions_check_override',
    complianceType: 'sanctions'
  }, {
    name: 'authorized_override',
    complianceType: 'authorized'
  }]

  // Prepare compliance overrides to save
  const overrides = _.map(field => {
    return (customer[field.name]) ? {
      customerId: id,
      complianceType: field.complianceType,
      overrideBy: userToken,
      verification: customer[field.name]
    } : null
  }, overrideFields)

  // Save all the updated compliance override fields
  return Promise.all(_.compact(overrides)
   .map(override => complianceOverrides.add(override)))
}

/**
 * Format and populate fields
 * for customer record
 *
 * @function format
 *
 * @param {object} Customer object
 * @returns {object} Customer camelized & populated with computed fields
 */
function format (customer) {
  /**
   * Populate with status field
   *
   */
  const status = _.maxBy('value', [{
    label: 'Phone',
    value: customer.phone_at
  }, {
    label: 'ID card',
    value: customer.id_card_at
  }, {
    label: 'Front facing camera',
    value: customer.front_facing_cam_at
  }, {
    label: 'ID card image',
    value: customer.id_card_image_at
  }])
  customer.status = status.label
  return camelize(customer)
}

/**
 * Query all customers
 *
 * Add status as computed column,
 * which will indicate the name of the latest
 * compliance verfication completed by user.
 *
 * @returns {array} Array of customers populated with status field
 */
function batch () {
  const sql = `select * from customers 
  where id != $1
  order by created desc limit $2`
  return db.any(sql, [ anonymous.uuid, NUM_RESULTS ])
  .then(_.map(format))
}

module.exports = { add, get, batch, getById, update}