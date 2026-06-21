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
  // Bumped on every mutation (create / rename / add / remove / reorder).
  // Drives per-playlist last-write-wins when merging local ↔ cloud, so a
  // concurrent edit on another device can't silently clobber this one.
  updatedAt: number;
}

// id → deletedAt(ms). A soft-delete "tombstone": carrying the delete forward
// across devices so a removed playlist doesn't resurrect when a stale copy
// from another device (or a re-login) is merged back in. A live playlist whose
// `updatedAt` is newer than its tombstone wins (edit-after-delete resurrects).
export type PlaylistTombstones = Record<string, number>;

export type Tab = "all" | "favorites" | "playlists";
