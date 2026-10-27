/** A capture waiting to go with the next prompt, drawn as a thumbnail above it. */
export type PendingShot = {
  id: string
  label: string
  /** The claimed capture's folder. */
  dir: string
  /** JPEG thumbnail, base64, for the desktop, editor and mobile surfaces. */
  thumbJpeg?: string
  /** PNG thumbnail on disk, for the terminal's Image. */
  thumbPng?: string
  thumbWidth: number
  thumbHeight: number
}

/** The captures each sent message carried, by the stored row's uuid, newest last. */
export type AttachedShots = { uuid: string; shots: PendingShot[] }[]

declare module 'claude-code' {
  interface PluginState {
    appshot: { pending: PendingShot[]; attached: AttachedShots }
  }
}
