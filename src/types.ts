export interface Song {
  id: number;
  name: string;
}

export interface RoomState {
  songId: number | null;
  songName: string | null;
  pickedBy: string | null;
  pickedAt: number | null;
  // True while the picker still has the fullscreen sheet open. Goes false
  // when the picker hits "close" — receivers should follow and close their
  // auto-opened sheet, but the picker's own close is the only one that
  // broadcasts. A receiver closing locally is private and doesn't touch
  // this flag. Optional for backwards-compat with old room snapshots
  // written before this field existed; missing → treat as still viewing.
  pickerViewing?: boolean;
}

export interface RoomOwner {
  clientId: string;
  claimedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  songIds: number[];
  createdAt: number;
}

export type Tab = "all" | "favorites" | "playlists";
