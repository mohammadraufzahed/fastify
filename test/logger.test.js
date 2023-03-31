'use strict'

const { plan, test, before } = require('tap')
const http = require('http')
const stream = require('stream')
const split = require('split2')
const Fastify = require('..')
const pino = require('pino')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { streamSym } = require('pino/lib/symbols')

const helper = require('./helper')
const { FST_ERR_LOG_INVALID_LOGGER } = require('../lib/errors')
const { once, on } = require('stream')

let count = 0
let localhost
let localhostForURL

function createDeferredPromise () {
  const promise = {}
  promise.promise = new Promise(function (resolve) {
    promise.resolve = resolve
  })
  return promise
}

function createTempFile () {
  const file = path.join(os.tmpdir(), `sonic-boom-${process.pid}-${process.hrtime().toString()}-${count++}`)
  function cleanup () {
    try {
      fs.unlinkSync(file)
    } catch { }
  }
  return { file, cleanup }
}

function request (url, cleanup = () => {}) {
  const promise = createDeferredPromise()
  http.get(url, (res) => {
    const chunks = []
    // we consume the response
    res.on('data', function (chunk) {
      chunks.push(chunk)
    })
    res.once('end', function () {
      cleanup(res, Buffer.concat(chunks).toString())
      promise.resolve()
    })
  })
  return promise.promise
}

plan(46)

before(async function () {
  [localhost, localhostForURL] = await helper.getLoopbackHost()
})

test('defaults to info level', async (t) => {
  const lines = [
    { reqId: /req-/, req: { method: 'GET' }, msg: 'incoming request' },
    { reqId: /req-/, res: { statusCode: 200 }, msg: 'request completed' }
  ]
  t.plan(lines.length * 2 + 1)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', function (req, reply) {
    t.ok(req.log)
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0 })

  await request(`http://${localhostForURL}:` + fastify.server.address().port)

  let id
  for await (const [line] of on(stream, 'data')) {
    // we skip the non-request log
    if (typeof line.reqId !== 'string') continue
    if (id === undefined && line.reqId) id = line.reqId
    if (id !== undefined && line.reqId) t.equal(line.reqId, id)
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('test log stream', async (t) => {
  const lines = [
    { msg: /^Server listening at / },
    { reqId: /req-/, req: { method: 'GET' }, msg: 'incoming request' },
    { reqId: /req-/, res: { statusCode: 200 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 3)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', function (req, reply) {
    t.ok(req.log)
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port)

  let id
  for await (const [line] of on(stream, 'data')) {
    if (id === undefined && line.reqId) id = line.reqId
    if (id !== undefined && line.reqId) t.equal(line.reqId, id)
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('test error log stream', async (t) => {
  const lines = [
    { msg: /^Server listening at / },
    { reqId: /req-/, req: { method: 'GET' }, msg: 'incoming request' },
    { reqId: /req-/, res: { statusCode: 500 }, msg: 'kaboom' },
    { reqId: /req-/, res: { statusCode: 500 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 4)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/error', function (req, reply) {
    t.ok(req.log)
    reply.send(new Error('kaboom'))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/error')

  let id
  for await (const [line] of on(stream, 'data')) {
    if (id === undefined && line.reqId) id = line.reqId
    if (id !== undefined && line.reqId) t.equal(line.reqId, id)
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('can use external logger instance', async (t) => {
  const lines = [/^Server listening at /, /^incoming request$/, /^log success$/, /^request completed$/]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = require('pino')(stream)

  const fastify = Fastify({ logger })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/foo', function (req, reply) {
    t.ok(req.log)
    req.log.info('log success')
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/foo')

  for await (const [line] of on(stream, 'data')) {
    const regex = lines.shift()
    t.ok(regex.test(line.msg), '"' + line.msg + '" dont match "' + regex + '"')
    if (lines.length === 0) break
  }
})

test('can use external logger instance with custom serializer', async (t) => {
  const lines = [['level', 30], ['req', { url: '/foo' }], ['level', 30], ['res', { statusCode: 200 }]]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)
  const logger = require('pino')({
    level: 'info',
    serializers: {
      req: function (req) {
        return {
          url: req.url
        }
      }
    }
  }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/foo', function (req, reply) {
    t.ok(req.log)
    req.log.info('log success')
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/foo')

  for await (const [line] of on(stream, 'data')) {
    const check = lines.shift()
    const key = check[0]
    const value = check[1]
    t.same(line[key], value)
    if (lines.length === 0) break
  }
})

test('should throw in case the external logger provided does not have a child method', async (t) => {
  t.plan(1)
  const loggerInstance = {
    info: console.info,
    error: console.error,
    debug: console.debug,
    fatal: console.error,
    warn: console.warn,
    trace: console.trace
  }

  try {
    const fastify = Fastify({ logger: loggerInstance })
    await fastify.ready()
  } catch (err) {
    t.equal(
      err instanceof FST_ERR_LOG_INVALID_LOGGER,
      true,
      "Invalid logger object provided. The logger instance should have these functions(s): 'child'."
    )
  }
})

test('should throw in case a partially matching logger is provided', async (t) => {
  t.plan(1)

  try {
    const fastify = Fastify({ logger: console })
    await fastify.ready()
  } catch (err) {
    t.equal(
      err instanceof FST_ERR_LOG_INVALID_LOGGER,
      true,
      "Invalid logger object provided. The logger instance should have these functions(s): 'fatal,child'."
    )
  }
})

test('expose the logger', async (t) => {
  t.plan(2)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  await fastify.ready()

  t.ok(fastify.log)
  t.same(typeof fastify.log, 'object')
})

test('The request id header key can be customized', async (t) => {
  const lines = ['incoming request', 'some log message', 'request completed']
  t.plan(lines.length * 2 + 2)
  const REQUEST_ID = '42'

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: { stream, level: 'info' },
    requestIdHeader: 'my-custom-request-id'
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    t.equal(req.id, REQUEST_ID)
    req.log.info('some log message')
    reply.send({ id: req.id })
  })

  const response = await fastify.inject({ method: 'GET', url: '/', headers: { 'my-custom-request-id': REQUEST_ID } })
  const body = await response.json()
  t.equal(body.id, REQUEST_ID)

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.reqId, REQUEST_ID)
    t.equal(line.msg, lines.shift(), 'message is set')
    if (lines.length === 0) break
  }
})

test('The request id header key can be ignored', async (t) => {
  const lines = ['incoming request', 'some log message', 'request completed']
  t.plan(lines.length * 2 + 2)
  const REQUEST_ID = 'ignore-me'

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: { stream, level: 'info' },
    requestIdHeader: false
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    t.equal(req.id, 'req-1')
    req.log.info('some log message')
    reply.send({ id: req.id })
  })
  const response = await fastify.inject({ method: 'GET', url: '/', headers: { 'request-id': REQUEST_ID } })
  const body = await response.json()
  t.equal(body.id, 'req-1')

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.reqId, 'req-1')
    t.equal(line.msg, lines.shift(), 'message is set')
    if (lines.length === 0) break
  }
})

test('The request id header key can be customized along with a custom id generator', async (t) => {
  const REQUEST_ID = '42'
  const matches = [
    { reqId: REQUEST_ID, msg: /incoming request/ },
    { reqId: REQUEST_ID, msg: /some log message/ },
    { reqId: REQUEST_ID, msg: /request completed/ },
    { reqId: 'foo', msg: /incoming request/ },
    { reqId: 'foo', msg: /some log message 2/ },
    { reqId: 'foo', msg: /request completed/ }
  ]
  t.plan(matches.length + 4)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: { stream, level: 'info' },
    requestIdHeader: 'my-custom-request-id',
    genReqId (req) {
      return 'foo'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/one', (req, reply) => {
    t.equal(req.id, REQUEST_ID)
    req.log.info('some log message')
    reply.send({ id: req.id })
  })

  fastify.get('/two', (req, reply) => {
    t.equal(req.id, 'foo')
    req.log.info('some log message 2')
    reply.send({ id: req.id })
  })

  {
    const response = await fastify.inject({ method: 'GET', url: '/one', headers: { 'my-custom-request-id': REQUEST_ID } })
    const body = await response.json()
    t.equal(body.id, REQUEST_ID)
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/two' })
    const body = await response.json()
    t.equal(body.id, 'foo')
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, matches.shift())
    if (matches.length === 0) break
  }
})

test('The request id header key can be ignored along with a custom id generator', async (t) => {
  const REQUEST_ID = 'ignore-me'
  const matches = [
    { reqId: 'foo', msg: /incoming request/ },
    { reqId: 'foo', msg: /some log message/ },
    { reqId: 'foo', msg: /request completed/ },
    { reqId: 'foo', msg: /incoming request/ },
    { reqId: 'foo', msg: /some log message 2/ },
    { reqId: 'foo', msg: /request completed/ }
  ]
  t.plan(matches.length + 4)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: { stream, level: 'info' },
    requestIdHeader: false,
    genReqId (req) {
      return 'foo'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/one', (req, reply) => {
    t.equal(req.id, 'foo')
    req.log.info('some log message')
    reply.send({ id: req.id })
  })

  fastify.get('/two', (req, reply) => {
    t.equal(req.id, 'foo')
    req.log.info('some log message 2')
    reply.send({ id: req.id })
  })

  {
    const response = await fastify.inject({ method: 'GET', url: '/one', headers: { 'request-id': REQUEST_ID } })
    const body = await response.json()
    t.equal(body.id, 'foo')
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/two' })
    const body = await response.json()
    t.equal(body.id, 'foo')
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, matches.shift())
    if (matches.length === 0) break
  }
})

test('The request id log label can be changed', async (t) => {
  const REQUEST_ID = '42'
  const matches = [
    { traceId: REQUEST_ID, msg: /incoming request/ },
    { traceId: REQUEST_ID, msg: /some log message/ },
    { traceId: REQUEST_ID, msg: /request completed/ }
  ]
  t.plan(matches.length + 2)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: { stream, level: 'info' },
    requestIdHeader: 'my-custom-request-id',
    requestIdLogLabel: 'traceId'
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/one', (req, reply) => {
    t.equal(req.id, REQUEST_ID)
    req.log.info('some log message')
    reply.send({ id: req.id })
  })

  {
    const response = await fastify.inject({ method: 'GET', url: '/one', headers: { 'my-custom-request-id': REQUEST_ID } })
    const body = await response.json()
    t.equal(body.id, REQUEST_ID)
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, matches.shift())
    if (matches.length === 0) break
  }
})

test('The logger should accept custom serializer', async (t) => {
  const lines = [
    { msg: /^Server listening at / },
    { req: { url: '/custom' }, msg: 'incoming request' },
    { res: { statusCode: 500 }, msg: 'kaboom' },
    { res: { statusCode: 500 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info',
      serializers: {
        req: function (req) {
          return {
            url: req.url
          }
        }
      }
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/custom', function (req, reply) {
    t.ok(req.log)
    reply.send(new Error('kaboom'))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/custom')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('reply.send logs an error if called twice in a row', async (t) => {
  const lines = ['incoming request', 'request completed', 'Reply already sent', 'Reply already sent']
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)
  const logger = pino(stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    reply.send({ hello: 'world' })
    reply.send({ hello: 'world2' })
    reply.send({ hello: 'world3' })
  })

  const response = await fastify.inject({ method: 'GET', url: '/' })
  const body = await response.json()
  t.same(body, { hello: 'world' })

  for await (const [line] of on(stream, 'data')) {
    t.same(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('logger can be silented', (t) => {
  t.plan(17)
  const fastify = Fastify({
    logger: false
  })
  t.teardown(fastify.close.bind(fastify))
  t.ok(fastify.log)
  t.equal(typeof fastify.log, 'object')
  t.equal(typeof fastify.log.fatal, 'function')
  t.equal(typeof fastify.log.error, 'function')
  t.equal(typeof fastify.log.warn, 'function')
  t.equal(typeof fastify.log.info, 'function')
  t.equal(typeof fastify.log.debug, 'function')
  t.equal(typeof fastify.log.trace, 'function')
  t.equal(typeof fastify.log.child, 'function')

  const childLog = fastify.log.child()

  t.equal(typeof childLog, 'object')
  t.equal(typeof childLog.fatal, 'function')
  t.equal(typeof childLog.error, 'function')
  t.equal(typeof childLog.warn, 'function')
  t.equal(typeof childLog.info, 'function')
  t.equal(typeof childLog.debug, 'function')
  t.equal(typeof childLog.trace, 'function')
  t.equal(typeof childLog.child, 'function')
})

test('Should set a custom logLevel for a plugin', async (t) => {
  const lines = ['incoming request', 'Hello', 'request completed']
  t.plan(lines.length + 2)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'error' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    req.log.info('Not Exist') // we should not see this log
    reply.send({ hello: 'world' })
  })

  fastify.register(function (instance, opts, done) {
    instance.get('/plugin', (req, reply) => {
      req.log.info('Hello') // we should see this log
      reply.send({ hello: 'world' })
    })
    done()
  }, { logLevel: 'info' })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/plugin' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.same(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set a custom logSerializers for a plugin', async (t) => {
  const lines = ['incoming request', 'XHello', 'request completed']
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'error' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.get('/plugin', (req, reply) => {
      req.log.info({ test: 'Hello' }) // we should see this log
      reply.send({ hello: 'world' })
    })
    done()
  }, { logLevel: 'info', logSerializers: { test: value => 'X' + value } })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/plugin' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    // either test or msg
    t.equal(line.test || line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set a custom logLevel for every plugin', async (t) => {
  const lines = ['incoming request', 'info', 'request completed', 'incoming request', 'debug', 'request completed']
  t.plan(lines.length * 2 + 3)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'error' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    req.log.warn('Hello') // we should not see this log
    reply.send({ hello: 'world' })
  })

  fastify.register(function (instance, opts, done) {
    instance.get('/info', (req, reply) => {
      req.log.info('info') // we should see this log
      req.log.debug('hidden log')
      reply.send({ hello: 'world' })
    })
    done()
  }, { logLevel: 'info' })

  fastify.register(function (instance, opts, done) {
    instance.get('/debug', (req, reply) => {
      req.log.debug('debug') // we should see this log
      req.log.trace('hidden log')
      reply.send({ hello: 'world' })
    })
    done()
  }, { logLevel: 'debug' })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/info' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/debug' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.ok(line.level === 30 || line.level === 20)
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set a custom logSerializers for every plugin', async (t) => {
  const lines = ['incoming request', 'Hello', 'request completed', 'incoming request', 'XHello', 'request completed', 'incoming request', 'ZHello', 'request completed']
  t.plan(lines.length + 3)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'info' }, stream)
  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', (req, reply) => {
    req.log.warn({ test: 'Hello' })
    reply.send({ hello: 'world' })
  })

  fastify.register(function (instance, opts, done) {
    instance.get('/test1', (req, reply) => {
      req.log.info({ test: 'Hello' })
      reply.send({ hello: 'world' })
    })
    done()
  }, { logSerializers: { test: value => 'X' + value } })

  fastify.register(function (instance, opts, done) {
    instance.get('/test2', (req, reply) => {
      req.log.info({ test: 'Hello' })
      reply.send({ hello: 'world' })
    })
    done()
  }, { logSerializers: { test: value => 'Z' + value } })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/test1' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/test2' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.test || line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should override serializers from route', async (t) => {
  const lines = ['incoming request', 'ZHello', 'request completed']
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'info' }, stream)
  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.get('/', {
      logSerializers: {
        test: value => 'Z' + value // should override
      }
    }, (req, reply) => {
      req.log.info({ test: 'Hello' })
      reply.send({ hello: 'world' })
    })
    done()
  }, { logSerializers: { test: value => 'X' + value } })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.test || line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should override serializers from plugin', async (t) => {
  const lines = ['incoming request', 'ZHello', 'request completed']
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'info' }, stream)
  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.register(context1, {
      logSerializers: {
        test: value => 'Z' + value // should override
      }
    })
    done()
  }, { logSerializers: { test: value => 'X' + value } })

  function context1 (instance, opts, done) {
    instance.get('/', (req, reply) => {
      req.log.info({ test: 'Hello' })
      reply.send({ hello: 'world' })
    })
    done()
  }

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.test || line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should use serializers from plugin and route', async (t) => {
  const lines = [
    { msg: 'incoming request' },
    { test: 'XHello', test2: 'ZHello' },
    { msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'info' }, stream)
  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(context1, {
    logSerializers: { test: value => 'X' + value }
  })

  function context1 (instance, opts, done) {
    instance.get('/', {
      logSerializers: {
        test2: value => 'Z' + value
      }
    }, (req, reply) => {
      req.log.info({ test: 'Hello', test2: 'Hello' }) // { test: 'XHello', test2: 'ZHello' }
      reply.send({ hello: 'world' })
    })
    done()
  }

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should use serializers from instance fastify and route', async (t) => {
  const lines = [
    { msg: 'incoming request' },
    { test: 'XHello', test2: 'ZHello' },
    { msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({
    level: 'info',
    serializers: {
      test: value => 'X' + value,
      test2: value => 'This should be override - ' + value
    }
  }, stream)
  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', {
    logSerializers: {
      test2: value => 'Z' + value
    }
  }, (req, reply) => {
    req.log.info({ test: 'Hello', test2: 'Hello' }) // { test: 'XHello', test2: 'ZHello' }
    reply.send({ hello: 'world' })
  })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should use serializers inherit from contexts', async (t) => {
  const lines = [
    { msg: 'incoming request' },
    { test: 'XHello', test2: 'YHello', test3: 'ZHello' },
    { msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({
    level: 'info',
    serializers: {
      test: value => 'X' + value
    }
  }, stream)

  const fastify = Fastify({ logger })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(context1, { logSerializers: { test2: value => 'Y' + value } })

  function context1 (instance, opts, done) {
    instance.get('/', {
      logSerializers: {
        test3: value => 'Z' + value
      }
    }, (req, reply) => {
      req.log.info({ test: 'Hello', test2: 'Hello', test3: 'Hello' }) // { test: 'XHello', test2: 'YHello', test3: 'ZHello' }
      reply.send({ hello: 'world' })
    })
    done()
  }

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should increase the log level for a specific plugin', async (t) => {
  const lines = ['Hello']
  t.plan(lines.length * 2 + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'info' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.get('/', (req, reply) => {
      req.log.error('Hello') // we should see this log
      reply.send({ hello: 'world' })
    })
    done()
  }, { logLevel: 'error' })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.level, 50)
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set the log level for the customized 404 handler', async (t) => {
  const lines = ['Hello']
  t.plan(lines.length * 2 + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'warn' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.setNotFoundHandler(function (req, reply) {
      req.log.error('Hello')
      reply.code(404).send()
    })
    done()
  }, { logLevel: 'error' })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    t.equal(response.statusCode, 404)
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.level, 50)
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set the log level for the customized 500 handler', async (t) => {
  const lines = ['Hello']
  t.plan(lines.length * 2 + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'warn' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.register(function (instance, opts, done) {
    instance.get('/', (req, reply) => {
      req.log.error('kaboom')
      reply.send(new Error('kaboom'))
    })

    instance.setErrorHandler(function (e, request, reply) {
      reply.log.fatal('Hello')
      reply.code(500).send()
    })
    done()
  }, { logLevel: 'fatal' })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/' })
    t.equal(response.statusCode, 500)
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.level, 60)
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('Should set a custom log level for a specific route', async (t) => {
  const lines = ['incoming request', 'Hello', 'request completed']
  t.plan(lines.length + 2)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'error' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/log', { logLevel: 'info' }, (req, reply) => {
    req.log.info('Hello')
    reply.send({ hello: 'world' })
  })

  fastify.get('/no-log', (req, reply) => {
    req.log.info('Hello')
    reply.send({ hello: 'world' })
  })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/log' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  {
    const response = await fastify.inject({ method: 'GET', url: '/no-log' })
    const body = await response.json()
    t.same(body, { hello: 'world' })
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('The default 404 handler logs the incoming request', async (t) => {
  const lines = ['incoming request', 'Route GET:/not-found not found', 'request completed']
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)

  const logger = pino({ level: 'trace' }, stream)

  const fastify = Fastify({
    logger
  })
  t.teardown(fastify.close.bind(fastify))

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/not-found' })
    t.equal(response.statusCode, 404)
  }

  for await (const [line] of on(stream, 'data')) {
    t.equal(line.msg, lines.shift())
    if (lines.length === 0) break
  }
})

test('should serialize request and response', async (t) => {
  const lines = [
    { req: { method: 'GET', url: '/500' }, msg: 'incoming request' },
    { req: { method: 'GET', url: '/500' }, msg: '500 error' },
    { msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)
  const fastify = Fastify({ logger: { level: 'info', stream } })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/500', (req, reply) => {
    reply.code(500).send(Error('500 error'))
  })

  await fastify.ready()

  {
    const response = await fastify.inject({ method: 'GET', url: '/500' })
    t.equal(response.statusCode, 500)
  }

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('Wrap IPv6 address in listening log message', async (t) => {
  t.plan(1)

  const interfaces = os.networkInterfaces()
  const ipv6 = Object.keys(interfaces)
    .filter(name => name.substr(0, 2) === 'lo')
    .map(name => interfaces[name])
    .reduce((list, set) => list.concat(set), [])
    .filter(info => info.family === 'IPv6')
    .map(info => info.address)
    .shift()

  if (ipv6 === undefined) {
    t.pass('No IPv6 loopback interface')
  } else {
    const stream = split(JSON.parse)
    const fastify = Fastify({
      logger: {
        stream,
        level: 'info'
      }
    })
    t.teardown(fastify.close.bind(fastify))

    await fastify.ready()
    await fastify.listen({ port: 0, host: ipv6 })

    {
      const [line] = await once(stream, 'data')
      t.same(line.msg, `Server listening at http://[${ipv6}]:${fastify.server.address().port}`)
    }
  }
})

test('Do not wrap IPv4 address', async (t) => {
  t.plan(1)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  await fastify.ready()
  await fastify.listen({ port: 0, host: '127.0.0.1' })

  {
    const [line] = await once(stream, 'data')
    t.same(line.msg, `Server listening at http://127.0.0.1:${fastify.server.address().port}`)
  }
})

test('file option', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { reqId: /req-/, req: { method: 'GET', url: '/' }, msg: 'incoming request' },
    { reqId: /req-/, res: { statusCode: 200 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 3)
  const { file, cleanup } = createTempFile(t)

  const fastify = Fastify({
    logger: { file }
  })
  t.teardown(() => {
    // cleanup the file after sonic-boom closed
    // otherwise we may face racing condition
    fastify.log[streamSym].once('close', cleanup)
    // we must flush the stream ourself
    // otherwise buffer may whole sonic-boom
    fastify.log[streamSym].flushSync()
    // end after flushing to actually close file
    fastify.log[streamSym].end()
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', function (req, reply) {
    t.ok(req.log)
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port)

  // we already own the full log
  const stream = fs.createReadStream(file).pipe(split(JSON.parse))
  t.teardown(stream.resume.bind(stream))

  let id
  for await (const [line] of on(stream, 'data')) {
    if (id === undefined && line.reqId) id = line.reqId
    if (id !== undefined && line.reqId) t.equal(line.reqId, id)
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should log the error if no error handler is defined', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { msg: 'incoming request' },
    { level: 50, msg: 'a generic error' },
    { res: { statusCode: 500 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 1)

  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/error', function (req, reply) {
    t.ok(req.log)
    reply.send(new Error('a generic error'))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/error')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should log as info if error status code >= 400 and < 500 if no error handler is defined', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { msg: 'incoming request' },
    { level: 30, msg: 'a 400 error' },
    { res: { statusCode: 400 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 1)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/400', function (req, reply) {
    t.ok(req.log)
    reply.send(Object.assign(new Error('a 400 error'), { statusCode: 400 }))
  })
  fastify.get('/503', function (req, reply) {
    t.ok(req.log)
    reply.send(Object.assign(new Error('a 503 error'), { statusCode: 503 }))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/400')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should log as error if error status code >= 500 if no error handler is defined', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { msg: 'incoming request' },
    { level: 50, msg: 'a 503 error' },
    { res: { statusCode: 503 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 1)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))
  fastify.get('/503', function (req, reply) {
    t.ok(req.log)
    reply.send(Object.assign(new Error('a 503 error'), { statusCode: 503 }))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/503')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should not log the error if error handler is defined and it does not error', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { level: 30, msg: 'incoming request' },
    { res: { statusCode: 200 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 2)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))
  fastify.get('/error', function (req, reply) {
    t.ok(req.log)
    reply.send(new Error('something happened'))
  })
  fastify.setErrorHandler((err, req, reply) => {
    t.ok(err)
    reply.send('something bad happened')
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/error')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should not rely on raw request to log errors', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { level: 30, msg: 'incoming request' },
    { res: { statusCode: 415 }, msg: 'something happened' },
    { res: { statusCode: 415 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 1)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      level: 'info'
    }
  })
  t.teardown(fastify.close.bind(fastify))
  fastify.get('/error', function (req, reply) {
    t.ok(req.log)
    reply.status(415).send(new Error('something happened'))
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request(`http://${localhostForURL}:` + fastify.server.address().port + '/error')

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should redact the authorization header if so specified', async (t) => {
  const lines = [
    { msg: /Server listening at/ },
    { req: { headers: { authorization: '[Redacted]' } }, msg: 'incoming request' },
    { res: { statusCode: 200 }, msg: 'request completed' }
  ]
  t.plan(lines.length + 3)
  const stream = split(JSON.parse)
  const fastify = Fastify({
    logger: {
      stream,
      redact: ['req.headers.authorization'],
      level: 'info',
      serializers: {
        req (req) {
          return {
            method: req.method,
            url: req.url,
            headers: req.headers,
            hostname: req.hostname,
            remoteAddress: req.ip,
            remotePort: req.socket.remotePort
          }
        }
      }
    }
  })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/', function (req, reply) {
    t.same(req.headers.authorization, 'Bearer abcde')
    reply.send({ hello: 'world' })
  })

  await fastify.ready()
  await fastify.listen({ port: 0, host: localhost })

  await request({
    method: 'GET',
    path: '/',
    host: localhost,
    port: fastify.server.address().port,
    headers: {
      authorization: 'Bearer abcde'
    }
  }, function (response, body) {
    t.equal(response.statusCode, 200)
    t.same(body, JSON.stringify({ hello: 'world' }))
  })

  for await (const [line] of on(stream, 'data')) {
    t.match(line, lines.shift())
    if (lines.length === 0) break
  }
})

test('should not log incoming request and outgoing response when disabled', async (t) => {
  t.plan(3)
  const stream = split(JSON.parse)
  const fastify = Fastify({ disableRequestLogging: true, logger: { level: 'info', stream } })
  t.teardown(fastify.close.bind(fastify))

  fastify.get('/500', (req, reply) => {
    reply.code(500).send(Error('500 error'))
  })

  await fastify.ready()

  await fastify.inject({ method: 'GET', url: '/500' })

  {
    const [line] = await once(stream, 'data')
    t.ok(line.reqId, 'reqId is defined')
    t.equal(line.msg, '500 error', 'message is set')
  }

  // no more readable data
  t.equal(stream.readableLength, 0)
})

test('should not log incoming request and outgoing response for 404 onBadUrl when disabled', async (t) => {
  t.plan(3)
  const stream = split(JSON.parse)
  const fastify = Fastify({ disableRequestLogging: true, logger: { level: 'info', stream } })
  t.teardown(fastify.close.bind(fastify))

  await fastify.ready()

  await fastify.inject({ method: 'GET', url: '/%c0' })

  {
    const [line] = await once(stream, 'data')
    t.ok(line.reqId, 'reqId is defined')
    t.equal(line.msg, 'Route GET:/%c0 not found', 'message is set')
  }

  // no more readable data
  t.equal(stream.readableLength, 0)
})

test('should pass when using unWritable props in the logger option', (t) => {
  t.plan(8)
  const fastify = Fastify({
    logger: Object.defineProperty({}, 'level', { value: 'info' })
  })
  t.teardown(fastify.close.bind(fastify))

  t.equal(typeof fastify.log, 'object')
  t.equal(typeof fastify.log.fatal, 'function')
  t.equal(typeof fastify.log.error, 'function')
  t.equal(typeof fastify.log.warn, 'function')
  t.equal(typeof fastify.log.info, 'function')
  t.equal(typeof fastify.log.debug, 'function')
  t.equal(typeof fastify.log.trace, 'function')
  t.equal(typeof fastify.log.child, 'function')
})

test('should be able to use a custom logger', (t) => {
  t.plan(7)

  const logger = {
    fatal: (msg) => { t.equal(msg, 'fatal') },
    error: (msg) => { t.equal(msg, 'error') },
    warn: (msg) => { t.equal(msg, 'warn') },
    info: (msg) => { t.equal(msg, 'info') },
    debug: (msg) => { t.equal(msg, 'debug') },
    trace: (msg) => { t.equal(msg, 'trace') },
    child: () => logger
  }

  const fastify = Fastify({ logger })
  t.teardown(fastify.close.bind(fastify))

  fastify.log.fatal('fatal')
  fastify.log.error('error')
  fastify.log.warn('warn')
  fastify.log.info('info')
  fastify.log.debug('debug')
  fastify.log.trace('trace')
  const child = fastify.log.child()
  t.equal(child, logger)
})

test('should create a default logger if provided one is invalid', (t) => {
  t.plan(8)

  const logger = new Date()

  const fastify = Fastify({ logger })
  t.teardown(fastify.close.bind(fastify))

  t.equal(typeof fastify.log, 'object')
  t.equal(typeof fastify.log.fatal, 'function')
  t.equal(typeof fastify.log.error, 'function')
  t.equal(typeof fastify.log.warn, 'function')
  t.equal(typeof fastify.log.info, 'function')
  t.equal(typeof fastify.log.debug, 'function')
  t.equal(typeof fastify.log.trace, 'function')
  t.equal(typeof fastify.log.child, 'function')
})

test('should not throw error when serializing custom req', (t) => {
  t.plan(1)

  const lines = []
  const dest = new stream.Writable({
    write: function (chunk, enc, cb) {
      lines.push(JSON.parse(chunk))
      cb()
    }
  })
  const fastify = Fastify({ logger: { level: 'info', stream: dest } })
  t.teardown(fastify.close.bind(fastify))

  fastify.log.info({ req: {} })

  t.same(lines[0].req, {})
})
