export interface Song {
  id: number;
  name: string;
  file: string;
}

export interface RoomState {
  songId: number | null;
  songName: string | null;
  pickedBy: string | null;
  pickedAt: number | null;
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
