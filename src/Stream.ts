import { UnsubscribeFn } from './ApiClient'
import Message from './Message'
import Client from './Client'
import { Envelope, fetcher } from '@xmtp/proto'

export type MessageTransformer<T> = (msg: Message) => T

export type MessageFilter = (msg: Message) => boolean

/**
 * Stream implements an Asynchronous Iterable over messages received from a topic.
 * As such can be used with constructs like for-await-of, yield*, array destructing, etc.
 */
export default class Stream<T> {
  topic: string
  client: Client
  // queue of incoming Waku messages
  messages: T[]
  // queue of already pending Promises
  resolvers: ((value: IteratorResult<T>) => void)[]
  // cache the callback so that it can be properly deregistered in Waku
  // if callback is undefined the stream is closed
  callback: ((env: Envelope) => Promise<void>) | undefined

  unsubscribeFn?: UnsubscribeFn

  constructor(
    client: Client,
    topic: string,
    messageTransformer: MessageTransformer<T>,
    messageFilter?: MessageFilter
  ) {
    this.messages = []
    this.resolvers = []
    this.topic = topic
    this.client = client
    this.callback = this.newMessageCallback(messageTransformer, messageFilter)
  }

  // returns new closure to handle incoming messages
  private newMessageCallback(
    transformer: MessageTransformer<T>,
    filter?: MessageFilter
  ): (env: Envelope) => Promise<void> {
    return async (env: Envelope) => {
      if (!env.message) {
        return
      }
      const msg = await this.client.decodeMessage(
        fetcher.b64Decode(env.message as unknown as string)
      )
      // If there is a filter on the stream, and the filter returns false, ignore the message
      if (filter && !filter(msg)) {
        return
      }
      // is there a Promise already pending?
      const resolver = this.resolvers.pop()
      if (resolver) {
        // yes, resolve it
        resolver({ value: transformer(msg) })
      } else {
        // no, push the message into the queue
        this.messages.unshift(transformer(msg))
      }
    }
  }

  private async start(): Promise<void> {
    if (!this.callback) {
      throw new Error('Missing callback for stream')
    }

    this.unsubscribeFn = this.client.apiClient.subscribe(
      {
        contentTopics: [this.topic],
      },
      async (env: Envelope) => {
        if (!this.callback) return
        await this?.callback(env)
      }
    )
  }

  static async create<T>(
    client: Client,
    topic: string,
    messageTransformer: MessageTransformer<T>,
    messageFilter?: MessageFilter
  ): Promise<Stream<T>> {
    const stream = new Stream(client, topic, messageTransformer, messageFilter)
    await stream.start()
    return stream
  }

  // To make Stream proper Async Iterable
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }

  // return should be called if the interpreter detects that the stream won't be used anymore,
  // e.g. a for/of loop was exited via a break. It can also be called explicitly.
  // https://tc39.es/ecma262/#table-iterator-interface-optional-properties
  // Note that this means the Stream will be closed after it was used in a for-await-of or yield* or similar.
  async return(): Promise<IteratorResult<T>> {
    if (this.unsubscribeFn) {
      await this.unsubscribeFn()
    }
    if (!this.callback) {
      return { value: undefined, done: true }
    }
    this.callback = undefined
    this.resolvers.forEach((resolve) =>
      resolve({ value: undefined, done: true })
    )
    return { value: undefined, done: true }
  }

  // To make Stream proper Async Iterator
  // Note that next() will still provide whatever messages were already pending
  // even after the stream was closed via return().
  next(): Promise<IteratorResult<T>> {
    // Is there a message already pending?
    const msg = this.messages.pop()
    if (msg) {
      // yes, return resolved promise
      return Promise.resolve({ value: msg })
    }
    if (!this.callback) {
      return Promise.resolve({ value: undefined, done: true })
    }
    // otherwise return empty Promise and queue its resolver
    return new Promise((resolve) => this.resolvers.unshift(resolve))
  }
}
