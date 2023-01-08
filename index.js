const _ = require('lodash')
const Bacon = require('baconjs')

module.exports = function(app) {

  let config = {}
  let unsubscribes = []
  let ruuviInitialized = false
  let ruuviTagsProperty = undefined

  const start = (initialConfig) => {
    config = _.cloneDeep(initialConfig)
    if (!ruuviInitialized) {
      ruuviTagsProperty = initializeRuuviListener()
      ruuviInitialized = true
    }

    const unsubConfig = ruuviTagsProperty.onValue(tags => {
      _.each(tags, ({id, dataStream}) => {
        if (!config[id]) {
            config[id] = {
              id: id,
              name: id.substring(0, 6),
              location: 'inside',
              enabled: false
            }
          }
      })
    })

    const allTagsDataStream = ruuviTagsProperty.flatMapLatest(tags => {
      const dataStreams = _.map(tags, ({id, dataStream}) => {
        return dataStream
          .skip(1)
          .map(data => createRuuviData(config, id, data))
          .map(data => performUnitConversions(data))
      })
      return Bacon.mergeAll(dataStreams)
    })


    const unsubData = allTagsDataStream.onValue(data => {
      if (data.enabled) {
        app.handleMessage('ruuvitag', createDelta(data))
      }
    })

    unsubscribes = [unsubData, unsubConfig]
  }

  const stop = () => {
    _.each(unsubscribes, fn => fn())
    unsubscribes = []
  }

  const schema = () => {
    const properties = _.mapValues(config, (c, id) => ({
      title: `Tag ${id}`,
      type: 'object',
      properties: {
        enabled: {
          title: 'Enabled. Receive data and emit Signal K values',
          type: 'boolean',
          default: false
        },
        name: {
          title: 'Source name',
          minLength: 1,
          maxLength: 12,
          description: 'Length: 1-12, Valid characters: (a-z, A-Z, 0-9)',
          type: 'string',
          pattern: '^[a-zA-Z0-9]+$',
          default: id.substring(0, 6)
        },
        location: {
          title: 'Location',
          minLength: 1,
          maxLength: 32,
          description: 'Tag location, for example `outside`. Default `inside.mainCabin`. Length: 0-32, Valid characters: (a-z, A-Z, 0-9)',
          type: 'string',
          pattern: '[a-zA-Z0-9]+(\.[a-zA-Z0-9])*',
          default: 'inside.mainCabin',
          maxLength: 32
        }
      }
    }))
    return {
      title: "",
      type: "object",
      properties
  }
}

  return {
    id: 'ruuvitag',
    name: 'RuuviTag Plugin',
    description: 'Provides environment data from nearby RuuviTags beacons.',
    schema,
    start,
    stop
  }
}

const initializeRuuviListener = () => {
  try {
    const ruuvi = require('node-ruuvitag')
    return Bacon.fromEvent(ruuvi, 'found')
      .map(tag => {
        const dataStream = Bacon.fromEvent(tag, 'updated')
        const id = tag.id
        return {id, dataStream}
      })
      .scan([], (acc, value) => acc.concat([value]))
  } catch(e) {
    console.error(`Error initializing signalk-ruuvitag-plugin: ${e.message}`)
    return Bacon.never()
  }
}

const createRuuviData = (config, id, data) => {
  return {
    id: id,
    name: _.get(config, [id, 'name'], id.substring(0, 6)),
    enabled: _.get(config, [id, 'enabled'], false),
    location: _.get(config, [id, 'location'], 'inside.mainCabin'),
    humidity: data.humidity,
    pressure: data.pressure,
    temperature: data.temperature,
    accelerationX: data.accelerationX,
    accelerationY: data.accelerationY,
    accelerationZ: data.accelerationZ,
    rssi: data.rssi,
    battery: data.battery,
    raw: !data.eddystoneId
  }
}

const performUnitConversions = (data) => {
  data.humidity = data.humidity / 100 // 38% -> 0.38
  data.temperature = data.temperature + 273.15 // C -> K
  data.battery = data.battery / 1000  // mV -> V
  data.accelerationX = data.accelerationX / 1000
  data.accelerationY = data.accelerationY / 1000
  data.accelerationZ = data.accelerationZ / 1000
  if (!data.raw) {
    data.pressure = data.pressure * 100  // hPa -> Pa
  }
  return data
}

const createDelta = (data) => {
  const humidityKey = data.location.indexOf('outside.') === 0 ? 'humidity' : 'relativeHumidity'
  return {
    updates: [
      {
        '$source': 'ruuvitag.' + data.name,
        values: [
          {
            path: `environment.${data.location}.${humidityKey}`,
            value: _.round(data.humidity, 5)
          },
          {
            path: `environment.${data.location}.temperature`,
            value: _.round(data.temperature, 3)
          },
          {
            path: `environment.${data.location}.pressure`,
            value: _.round(data.pressure)
          },
          {
            path: `environment.${data.location}.accelerationX`,
            value: _.round(data.accelerationX, 5)
          },
          {
            path: `environment.${data.location}.accelerationY`,
            value: _.round(data.accelerationY, 5)
          },
          {
            path: `environment.${data.location}.accelerationZ`,
            value: _.round(data.accelerationZ, 5)
          },
          {
            path: `environment.${data.location}.rssi`,
            value: _.round(data.rssi)
          },
          {
            path: `electrical.batteries.${data.name}.voltage`,
            value: _.round(data.battery, 3)
          }
        ]
      }
    ]
  }
}
