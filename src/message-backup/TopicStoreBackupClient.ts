import { Conversations } from '../conversations'
import BackupClient, {
  BackupType,
  TopicStoreBackupConfiguration,
} from './BackupClient'

const BACKUP_TYPE = BackupType.xmtpTopicStore
export default class TopicStoreBackupClient implements BackupClient {
  private _configuration: TopicStoreBackupConfiguration
  private _conversations: Conversations
  // A queue of background tasks to be done. Each promise is chained onto the previous one.
  private _queue: Promise<void>

  public static createConfiguration(
    walletAddress: string
  ): TopicStoreBackupConfiguration {
    // TODO: randomly generate topic and encryption key
    return {
      type: BACKUP_TYPE,
      version: 0,
      topic: 'history-v0:' + walletAddress,
    }
  }

  constructor(
    configuration: TopicStoreBackupConfiguration,
    conversations: Conversations
  ) {
    this._configuration = configuration
    this._conversations = conversations
    this._queue = Promise.resolve()
    this.initialize()
  }

  public get backupType(): BackupType {
    return BACKUP_TYPE
  }

  private initialize(): void {
    // TODO: error handling
    this.queueTask(async () => {
      const conversations = await this._conversations.list()
      await Promise.all(
        conversations.map(async (conversation) => {
          const messagesInConversation = await conversation.messages()
          console.log(messagesInConversation)
        })
      )
    })
    this.subscribeToNewMessages()
  }

  private async subscribeToNewMessages(): Promise<void> {
    for await (const message of await this._conversations.streamAllMessages()) {
      // if (message.senderAddress === this.configuration_address) {
      //   // This message was sent from me
      //   continue
      // }
      this.queueTask(() => {
        console.log(
          `New message from ${message.senderAddress}: ${message.content}`
        )
        return Promise.resolve()
      })
    }
  }

  private queueTask(task: () => Promise<void>): void {
    this._queue = this._queue.then(task)
  }
}
