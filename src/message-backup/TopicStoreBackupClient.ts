import { Conversations } from '../conversations'
import BackupClient, {
  BackupType,
  TopicStoreBackupConfiguration,
} from './BackupClient'

const BACKUP_TYPE = BackupType.xmtpTopicStore
export default class TopicStoreBackupClient implements BackupClient {
  private _configuration: TopicStoreBackupConfiguration
  // A queue of background tasks to be done. Each promise is chained onto the previous one.
  private _queue: Promise<void>
  private _conversations: Conversations

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
    this._queue = this.initialize()
  }

  public get backupType(): BackupType {
    return BACKUP_TYPE
  }

  private async initialize(): Promise<void> {
    // 1. fetch everything
    // 2. incremental updates after that
    return Promise.resolve()
  }
}
