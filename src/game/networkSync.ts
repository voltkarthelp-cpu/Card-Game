import { Card, CardColor, GameTableState, Player } from '../types/game';

export type NetworkMessage =
  | { type: 'JOIN_REQUEST'; roomCode: string; player: Player }
  | { type: 'LOBBY_UPDATE'; roomCode: string; players: Player[]; hostId: string }
  | { type: 'GAME_STARTED'; roomCode: string; tableState: GameTableState }
  | { type: 'TABLE_SYNC'; roomCode: string; tableState: GameTableState }
  | { type: 'ACTION_PLAY'; roomCode: string; playerId: string; cardId: string; chosenColor?: CardColor; calledUno?: boolean }
  | { type: 'ACTION_DRAW'; roomCode: string; playerId: string }
  | { type: 'ACTION_CALL_UNO'; roomCode: string; playerId: string }
  | { type: 'ACTION_CATCH_UNO'; roomCode: string; catcherId: string; targetPlayerId: string }
  | { type: 'HOST_LEAVE'; roomCode: string };

class NetworkSyncManager {
  private channel: BroadcastChannel | null = null;
  private messageListeners: ((msg: NetworkMessage) => void)[] = [];
  private activeRoomCode: string = '';
  private pollAbortController: AbortController | null = null;
  private currentVersion: number = 0;
  private processedActionIds = new Set<string>();

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel('card_clash_sync_bus');
        this.channel.onmessage = (event) => {
          this.handleIncoming(event.data);
        };
      } catch {
        // Fallback
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === 'card_clash_latest_msg' && e.newValue) {
          try {
            const data = JSON.parse(e.newValue);
            this.handleIncoming(data);
          } catch {}
        }
      });
    }
  }

  private handleIncoming(msg: NetworkMessage) {
    this.messageListeners.forEach((listener) => {
      try {
        listener(msg);
      } catch (err) {
        console.error('Error in network message handler', err);
      }
    });
  }

  public subscribe(listener: (msg: NetworkMessage) => void): () => void {
    this.messageListeners.push(listener);
    return () => {
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    };
  }

  public broadcast(msg: NetworkMessage) {
    // 1. Local tab broadcast
    if (this.channel) {
      try {
        this.channel.postMessage(msg);
      } catch {}
    }
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(
          'card_clash_latest_msg',
          JSON.stringify({ ...msg, _t: Date.now() })
        );
      } catch {}
    }

    // 2. Multi-device server synchronization
    this.pushToServer(msg);
  }

  // Multi-device server API calls
  private async pushToServer(msg: NetworkMessage) {
    if (typeof window === 'undefined') return;
    try {
      const code = msg.roomCode.toUpperCase();
      if (msg.type === 'JOIN_REQUEST') {
        await fetch(`/api/rooms/${code}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player: msg.player }),
        });
      } else if (msg.type === 'TABLE_SYNC' || msg.type === 'GAME_STARTED') {
        await fetch(`/api/rooms/${code}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tableState: msg.tableState }),
        });
      } else if (msg.type === 'LOBBY_UPDATE') {
        await fetch(`/api/rooms/${code}/lobby`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ players: msg.players, hostId: msg.hostId }),
        });
      } else if (
        msg.type === 'ACTION_PLAY' ||
        msg.type === 'ACTION_DRAW' ||
        msg.type === 'ACTION_CALL_UNO' ||
        msg.type === 'ACTION_CATCH_UNO'
      ) {
        await fetch(`/api/rooms/${code}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: msg }),
        });
      }
    } catch {
      // In offline or non-server fallback
    }
  }

  public async leaveRoom(roomCode: string, playerId: string) {
    if (typeof window === 'undefined') return;
    try {
      await fetch(`/api/rooms/${roomCode.toUpperCase()}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
    } catch {}
  }

  /**
   * Start polling server for real-time room updates across separate devices
   */
  public startServerSync(roomCode: string, isHost: boolean) {
    this.activeRoomCode = roomCode.toUpperCase();
    this.currentVersion = 0;
    this.stopServerSync();

    this.pollAbortController = new AbortController();
    const signal = this.pollAbortController.signal;

    const poll = async () => {
      if (signal.aborted || !this.activeRoomCode) return;
      try {
        const res = await fetch(
          `/api/rooms/${this.activeRoomCode}/poll?version=${this.currentVersion}`,
          { signal }
        );
        if (res.ok) {
          const room = await res.json();
          if (room && !room.noChange) {
            this.currentVersion = room.version;

            // Handle actions posted by clients if we are host
            if (isHost && room.actions && Array.isArray(room.actions)) {
              room.actions.forEach((act: any) => {
                if (act.id && !this.processedActionIds.has(act.id)) {
                  this.processedActionIds.add(act.id);
                  this.handleIncoming(act);
                }
              });
            }

            // If we are not host and table state or lobby changed, update
            if (!isHost) {
              if (room.tableState) {
                this.handleIncoming({
                  type: 'TABLE_SYNC',
                  roomCode: this.activeRoomCode,
                  tableState: room.tableState,
                });
              } else if (room.players) {
                this.handleIncoming({
                  type: 'LOBBY_UPDATE',
                  roomCode: this.activeRoomCode,
                  players: room.players,
                  hostId: room.hostId,
                });
              }
            } else {
              // Host updates players if a new peer joined
              if (room.players) {
                this.handleIncoming({
                  type: 'LOBBY_UPDATE',
                  roomCode: this.activeRoomCode,
                  players: room.players,
                  hostId: room.hostId,
                });
              }
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          // Retry after brief backoff
          await new Promise((r) => setTimeout(r, 600));
        }
      }

      if (!signal.aborted) {
        setTimeout(poll, 300);
      }
    };

    poll();
  }

  public stopServerSync() {
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }
  }

  public generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}

export const networkSync = new NetworkSyncManager();
