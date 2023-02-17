import BackupClient, { BackupType, NoBackupConfiguration } from './BackupClient'

const BACKUP_TYPE = BackupType.none
export default class NoBackupClient implements BackupClient {
  private _configuration: NoBackupConfiguration

  public static createConfiguration(): NoBackupConfiguration {
    return {
      type: BACKUP_TYPE,
      version: 0,
    }
  }

  constructor(configuration: NoBackupConfiguration) {
    this._configuration = configuration
  }

  public get backupType(): BackupType {
    return BACKUP_TYPE
  }
}
