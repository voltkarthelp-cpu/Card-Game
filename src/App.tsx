import React, { useState, useEffect, useRef } from 'react';
import { TitleScreen } from './components/screens/TitleScreen';
import { HostSetupScreen } from './components/screens/HostSetupScreen';
import { JoinScreen } from './components/screens/JoinScreen';
import { LobbyScreen } from './components/screens/LobbyScreen';
import { GameTable } from './components/screens/GameTable';
import { RulesModal } from './components/screens/RulesModal';
import { DiagnosticsModal } from './components/screens/DiagnosticsModal';
import { AvatarId, Card, CardColor, GameMode, GamePhase, GameRules, GameTableState, Player } from './types/game';
import {
  calculateRoundScore,
  getNextPlayerIndex,
  replenishDrawPile,
  startNewRound,
} from './game/cardEngine';
import { networkSync, NetworkMessage } from './game/networkSync';
import { soundFx } from './sound/soundFx';

const MODERN_AVATARS: AvatarId[] = [
  'dragon',
  'phoenix',
  'tiger',
  'wolf',
  'falcon',
  'bear',
  'fox',
  'viper',
];

export default function App() {
  const initialRoomFromUrl = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('room')
    : null;

  // Screen and Mode States
  const [phase, setPhase] = useState<GamePhase>(initialRoomFromUrl ? 'JOIN' : 'TITLE');
  const [gameMode, setGameMode] = useState<GameMode>('multiplayer');
  const [localPlayerId, setLocalPlayerId] = useState<string>(initialRoomFromUrl ? 'p_peer' : 'p_host');
  const [isHost, setIsHost] = useState(!initialRoomFromUrl);

  // Modern Audio Controls
  const [musicMuted, setMusicMuted] = useState(false);
  const [sfxMuted, setSfxMuted] = useState(false);

  // Modals
  const [showRules, setShowRules] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showPassAndPlayPicker, setShowPassAndPlayPicker] = useState(false);

  // Pass & Play interstitial
  const [passAndPlayWaiting, setPassAndPlayWaiting] = useState(false);

  // Default game rules: Up to 8 players, bot-free
  const [rules, setRules] = useState<GameRules>({
    playerLimit: 8,
    startingHandSize: 7,
    targetScore: 250,
    stacking: true,
    drawUntilPlayable: false,
    unoPenaltyCards: 2,
    turnTimeoutSeconds: 0,
  });

  // Authoritative full deck (kept by host or local session)
  const fullDeckRef = useRef<Card[]>([]);

  // Authoritative Game Table State
  const [tableState, setTableState] = useState<GameTableState>(() => {
    const code = initialRoomFromUrl ? initialRoomFromUrl.toUpperCase() : networkSync.generateRoomCode();
    return {
      roomCode: code,
      hostId: 'p_host',
      phase: initialRoomFromUrl ? 'JOIN' : 'TITLE',
      mode: 'multiplayer',
      rules: {
        playerLimit: 8,
        startingHandSize: 7,
        targetScore: 250,
        stacking: true,
        drawUntilPlayable: false,
        unoPenaltyCards: 2,
        turnTimeoutSeconds: 0,
      },
      players: [],
      currentPlayerIndex: 0,
      direction: 1,
      discardPile: [],
      drawPileCount: 0,
      activeColor: 'red',
      pendingDrawPenalty: 0,
      unoCallPendingPlayerId: null,
      lastActionMessage: 'Welcome to Card Clash!',
      roundNumber: 0,
      roundWinnerId: null,
      matchWinnerId: null,
      turnStartTime: Date.now(),
    };
  });

  // Listen for peer network broadcast messages
  useEffect(() => {
    const unsubscribe = networkSync.subscribe((msg: NetworkMessage) => {
      if (msg.roomCode !== tableState.roomCode) return;

      if (msg.type === 'JOIN_REQUEST' && isHost) {
        // Host adds new human player to lobby
        setTableState((prev) => {
          if (prev.players.length >= prev.rules.playerLimit) return prev;
          if (prev.players.some((p) => p.id === msg.player.id)) return prev;
          const updatedPlayers = [...prev.players, msg.player];
          networkSync.broadcast({
            type: 'LOBBY_UPDATE',
            roomCode: prev.roomCode,
            players: updatedPlayers,
            hostId: prev.hostId,
          });
          return { ...prev, players: updatedPlayers };
        });
      } else if (msg.type === 'LOBBY_UPDATE') {
        // Both host and joined peers update their lobby player list
        setTableState((prev) => {
          if (prev.phase === 'PLAYING') return prev;
          return {
            ...prev,
            players: msg.players,
            hostId: msg.hostId || prev.hostId,
          };
        });
      } else if (msg.type === 'GAME_STARTED' && !isHost) {
        setTableState(msg.tableState);
        setPhase('PLAYING');
      } else if (msg.type === 'TABLE_SYNC') {
        setTableState(msg.tableState);
        // Automatically switch joining peers into active game view
        if (msg.tableState.phase === 'PLAYING') {
          setPhase('PLAYING');
        }
      } else if (msg.type === 'ACTION_PLAY' && isHost) {
        executePlayCard(msg.playerId, msg.cardId, msg.chosenColor, msg.calledUno);
      } else if (msg.type === 'ACTION_DRAW' && isHost) {
        executeDrawCard(msg.playerId);
      } else if (msg.type === 'ACTION_CALL_UNO' && isHost) {
        executeCallUno(msg.playerId);
      } else if (msg.type === 'ACTION_CATCH_UNO' && isHost) {
        executeCatchUno(msg.catcherId, msg.targetPlayerId);
      }
    });

    return unsubscribe;
  }, [tableState.roomCode, isHost]);

  // Audio toggles
  const handleToggleMusic = () => {
    const isNowMuted = soundFx.toggleMusic();
    setMusicMuted(isNowMuted);
  };

  const handleToggleSfx = () => {
    const isNowMuted = soundFx.toggleSfx();
    setSfxMuted(isNowMuted);
  };

  // --- GAME START HANDLERS ---

  // 1. Pass & Play Start (2 to 8 human players on one phone or tablet)
  const handleStartPassAndPlay = (playerCount: number = 4) => {
    const initialPlayers: Player[] = Array.from({ length: playerCount }).map((_, idx) => ({
      id: `p_human_${idx + 1}`,
      name: `Player ${idx + 1}`,
      avatar: MODERN_AVATARS[idx % MODERN_AVATARS.length],
      isBot: false,
      hand: [],
      handCount: 0,
      score: 0,
      isHost: idx === 0,
      hasCalledUno: false,
      isReady: true,
      isConnected: true,
    }));

    setLocalPlayerId(initialPlayers[0].id);
    setIsHost(true);
    setGameMode('pass_and_play');

    const freshRules = { ...rules, playerLimit: playerCount };
    setRules(freshRules);

    const freshState: GameTableState = {
      ...tableState,
      roomCode: networkSync.generateRoomCode(),
      hostId: initialPlayers[0].id,
      mode: 'pass_and_play',
      rules: freshRules,
      players: initialPlayers,
      roundNumber: 0,
    };

    const { deck, tableState: dealtState } = startNewRound(freshState, freshRules);
    fullDeckRef.current = deck;
    setTableState(dealtState);
    setPhase('PLAYING');
    setShowPassAndPlayPicker(false);
  };

  // 2. Start Host Setup (generates fresh room code and syncs URL)
  const handleStartHost = () => {
    const freshCode = networkSync.generateRoomCode();
    setTableState((prev) => ({ ...prev, roomCode: freshCode }));
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '?room=' + freshCode);
    }
    setPhase('HOST_SETUP');
  };

  // 3. Confirm Host Screen
  const handleConfirmHost = (
    hostName: string,
    avatar: AvatarId,
    newRules: GameRules,
    code: string
  ) => {
    const finalCode = code.toUpperCase();
    setRules(newRules);
    const hostPlayer: Player = {
      id: 'p_host_' + Date.now().toString(36),
      name: hostName,
      avatar,
      isBot: false,
      hand: [],
      handCount: 0,
      score: 0,
      isHost: true,
      hasCalledUno: false,
      isReady: true,
      isConnected: true,
    };

    setLocalPlayerId(hostPlayer.id);
    setIsHost(true);
    setGameMode('multiplayer');

    setTableState((prev) => ({
      ...prev,
      roomCode: finalCode,
      hostId: hostPlayer.id,
      rules: newRules,
      players: [hostPlayer],
      phase: 'LOBBY',
    }));

    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '?room=' + finalCode);
    }

    // Start background sync for multi-device & Wi-Fi peers
    networkSync.startServerSync(finalCode, true);

    // Broadcast host registration
    networkSync.broadcast({
      type: 'JOIN_REQUEST',
      roomCode: finalCode,
      player: hostPlayer,
    });

    setPhase('LOBBY');
  };

  // 4. Confirm Join Screen
  const handleConfirmJoin = (name: string, avatar: AvatarId, code: string) => {
    const finalCode = code.toUpperCase();
    const peerPlayer: Player = {
      id: 'p_client_' + Date.now().toString(36),
      name,
      avatar,
      isBot: false,
      hand: [],
      handCount: 0,
      score: 0,
      isHost: false,
      hasCalledUno: false,
      isReady: true,
      isConnected: true,
    };

    setLocalPlayerId(peerPlayer.id);
    setIsHost(false);
    setGameMode('multiplayer');

    setTableState((prev) => ({
      ...prev,
      roomCode: finalCode,
      players: [peerPlayer],
    }));

    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', '?room=' + finalCode);
    }

    // Start background sync for client
    networkSync.startServerSync(finalCode, false);

    // Broadcast join request to host
    networkSync.broadcast({
      type: 'JOIN_REQUEST',
      roomCode: finalCode,
      player: peerPlayer,
    });

    setPhase('LOBBY');
  };

  const handleLeaveRoom = () => {
    if (tableState.roomCode && localPlayerId) {
      networkSync.leaveRoom(tableState.roomCode, localPlayerId);
    }
    networkSync.stopServerSync();
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', window.location.pathname);
    }
    setPhase('TITLE');
  };

  // Lobby: Remove Player (Host only)
  const handleRemovePlayer = (id: string) => {
    if (!isHost) return;
    setTableState((prev) => {
      const updated = prev.players.filter((p) => p.id !== id);
      networkSync.broadcast({
        type: 'LOBBY_UPDATE',
        roomCode: prev.roomCode,
        players: updated,
        hostId: prev.hostId,
      });
      return { ...prev, players: updated };
    });
  };

  // Host: Start Match from Lobby
  const handleHostStartGame = () => {
    if (!isHost || tableState.players.length < 2) return;
    const { deck, tableState: dealtState } = startNewRound(tableState, rules);
    fullDeckRef.current = deck;
    setTableState(dealtState);
    setPhase('PLAYING');

    // Broadcast started state
    networkSync.broadcast({
      type: 'GAME_STARTED',
      roomCode: tableState.roomCode,
      tableState: dealtState,
    });
  };

  // --- AUTHORITATIVE IN-GAME MOVE EXECUTION ---

  // Play Card
  const executePlayCard = (
    playerId: string,
    cardId: string,
    chosenColor?: CardColor,
    calledUno?: boolean
  ) => {
    setTableState((prev) => {
      const playerIndex = prev.players.findIndex((p) => p.id === playerId);
      if (playerIndex === -1) return prev;

      const player = prev.players[playerIndex];
      const card = player.hand.find((c) => c.id === cardId);
      if (!card) return prev;

      // Remove card from player hand
      const newHand = player.hand.filter((c) => c.id !== cardId);

      // Check Uno status
      let hasCalledUno = player.hasCalledUno;
      let pendingUnoPlayerId = prev.unoCallPendingPlayerId;

      if (newHand.length === 1) {
        if (calledUno) {
          hasCalledUno = true;
          pendingUnoPlayerId = null;
        } else {
          hasCalledUno = false;
          pendingUnoPlayerId = player.id;
        }
      } else {
        hasCalledUno = false;
      }

      const updatedPlayer: Player = {
        ...player,
        hand: newHand,
        handCount: newHand.length,
        hasCalledUno,
      };

      const updatedPlayers = [...prev.players];
      updatedPlayers[playerIndex] = updatedPlayer;

      // Check for round win (empty hand!)
      if (newHand.length === 0) {
        soundFx.playRoundWin();
        const roundPoints = calculateRoundScore(updatedPlayers, player.id);
        const newScore = player.score + roundPoints;
        updatedPlayers[playerIndex] = { ...updatedPlayer, score: newScore };

        const isMatchWon = newScore >= prev.rules.targetScore;

        const roundEndState: GameTableState = {
          ...prev,
          phase: 'ROUND_END',
          players: updatedPlayers,
          discardPile: [...prev.discardPile, card],
          roundWinnerId: player.id,
          matchWinnerId: isMatchWon ? player.id : null,
          lastActionMessage: `🏆 ${player.name} emptied their hand and scored +${roundPoints} points!`,
          lastActionType: 'play',
        };

        if (isHost) {
          networkSync.broadcast({
            type: 'TABLE_SYNC',
            roomCode: prev.roomCode,
            tableState: roundEndState,
          });
        }
        return roundEndState;
      }

      // Trigger specific sounds for card play
      if (calledUno) {
        soundFx.playUnoCall();
      } else if (card.type === 'wild' || card.type === 'wild4') {
        soundFx.playWild();
      } else if (card.type === 'draw2') {
        soundFx.playDrawPenalty();
      } else if (card.type === 'skip') {
        soundFx.playSkip();
      } else if (card.type === 'reverse') {
        soundFx.playReverse();
      } else {
        soundFx.playCardPlay();
      }

      // Handle card effects and turn rotation
      let newDirection = prev.direction;
      let nextStep = 1;
      let newActiveColor: CardColor = card.color === 'wild' && chosenColor ? chosenColor : card.color;
      let pendingPenalty = prev.pendingDrawPenalty;
      let actionType: GameTableState['lastActionType'] = 'play';
      let actionMsg = `${player.name} played ${card.color.toUpperCase()} ${card.type.toUpperCase()}`;

      if (card.type === 'skip') {
        nextStep = 2;
        actionType = 'skip';
        actionMsg = `⊘ ${player.name} played Skip! Next player skipped.`;
      } else if (card.type === 'reverse') {
        actionType = 'reverse';
        if (prev.players.length === 2) {
          nextStep = 2; // Acts like Skip in 2-player UNO
          actionMsg = `⇄ ${player.name} played Reverse (Acts as Skip in 2P)!`;
        } else {
          newDirection = (prev.direction * -1) as 1 | -1;
          nextStep = 1;
          actionMsg = `⇄ ${player.name} reversed play order!`;
        }
      } else if (card.type === 'draw2') {
        actionType = 'penalty';
        if (prev.rules.stacking) {
          pendingPenalty += 2;
          nextStep = 1;
          actionMsg = `+2 ${player.name} played Draw Two! (Stack: +${pendingPenalty})`;
        } else {
          const victimIndex = getNextPlayerIndex(prev.currentPlayerIndex, newDirection, 1, prev.players.length);
          const victim = updatedPlayers[victimIndex];
          const cardsDrawn = drawCardsFromDeck(2);
          updatedPlayers[victimIndex] = {
            ...victim,
            hand: [...victim.hand, ...cardsDrawn],
            handCount: victim.hand.length + cardsDrawn.length,
          };
          nextStep = 2;
          actionMsg = `+2 ${player.name} hit ${victim.name} with +2 cards!`;
        }
      } else if (card.type === 'wild') {
        actionType = 'wild';
        actionMsg = `★ ${player.name} changed color to ${newActiveColor.toUpperCase()}!`;
      } else if (card.type === 'wild4') {
        actionType = 'wild';
        if (prev.rules.stacking) {
          pendingPenalty += 4;
          nextStep = 1;
          actionMsg = `★+4 ${player.name} played Wild +4 to ${newActiveColor.toUpperCase()}! (Stack: +${pendingPenalty})`;
        } else {
          const victimIndex = getNextPlayerIndex(prev.currentPlayerIndex, newDirection, 1, prev.players.length);
          const victim = updatedPlayers[victimIndex];
          const cardsDrawn = drawCardsFromDeck(4);
          updatedPlayers[victimIndex] = {
            ...victim,
            hand: [...victim.hand, ...cardsDrawn],
            handCount: victim.hand.length + cardsDrawn.length,
          };
          nextStep = 2;
          actionMsg = `★+4 ${player.name} played Wild +4! ${victim.name} draws 4 and is skipped!`;
        }
      }

      if (calledUno) {
        actionMsg += ` 🚨 ${player.name} called UNO!`;
        actionType = 'uno';
      }

      const nextPlayerIndex = getNextPlayerIndex(
        prev.currentPlayerIndex,
        newDirection,
        nextStep,
        prev.players.length
      );

      const nextTableState: GameTableState = {
        ...prev,
        players: updatedPlayers,
        currentPlayerIndex: nextPlayerIndex,
        direction: newDirection,
        discardPile: [...prev.discardPile, card],
        activeColor: newActiveColor,
        pendingDrawPenalty: pendingPenalty,
        unoCallPendingPlayerId: pendingUnoPlayerId,
        lastActionMessage: actionMsg,
        lastActionType: actionType,
        turnStartTime: Date.now(),
      };

      // Pass & Play handoff check
      if (prev.mode === 'pass_and_play') {
        setLocalPlayerId(updatedPlayers[nextPlayerIndex].id);
        setPassAndPlayWaiting(true);
      }

      if (isHost) {
        networkSync.broadcast({
          type: 'TABLE_SYNC',
          roomCode: prev.roomCode,
          tableState: nextTableState,
        });
      }

      return nextTableState;
    });
  };

  // Draw Card Helper
  const drawCardsFromDeck = (count: number): Card[] => {
    let deck = fullDeckRef.current;
    const drawn: Card[] = [];

    for (let i = 0; i < count; i++) {
      if (deck.length === 0) {
        const replenished = replenishDrawPile([], tableState.discardPile);
        deck = replenished.newDrawPile;
      }
      if (deck.length > 0) {
        drawn.push(deck.pop()!);
      }
    }

    fullDeckRef.current = deck;
    return drawn;
  };

  // Draw Card Action
  const executeDrawCard = (playerId: string) => {
    setTableState((prev) => {
      const playerIndex = prev.players.findIndex((p) => p.id === playerId);
      if (playerIndex === -1) return prev;

      const player = prev.players[playerIndex];
      const countToDraw = prev.pendingDrawPenalty > 0 ? prev.pendingDrawPenalty : 1;

      // Trigger chiptune sound for draw action
      if (prev.pendingDrawPenalty > 0) {
        soundFx.playDrawPenalty();
      } else {
        soundFx.playCardDraw();
      }

      const drawnCards = drawCardsFromDeck(countToDraw);

      const updatedPlayer: Player = {
        ...player,
        hand: [...player.hand, ...drawnCards],
        handCount: player.hand.length + drawnCards.length,
        hasCalledUno: false,
      };

      const updatedPlayers = [...prev.players];
      updatedPlayers[playerIndex] = updatedPlayer;

      const nextIndex = getNextPlayerIndex(prev.currentPlayerIndex, prev.direction, 1, prev.players.length);

      const actionMsg =
        prev.pendingDrawPenalty > 0
          ? `${player.name} drew +${prev.pendingDrawPenalty} stacked cards!`
          : `${player.name} drew a card.`;

      const nextTableState: GameTableState = {
        ...prev,
        players: updatedPlayers,
        currentPlayerIndex: nextIndex,
        drawPileCount: fullDeckRef.current.length,
        pendingDrawPenalty: 0,
        lastActionMessage: actionMsg,
        lastActionType: 'draw',
        turnStartTime: Date.now(),
      };

      if (prev.mode === 'pass_and_play') {
        setLocalPlayerId(updatedPlayers[nextIndex].id);
        setPassAndPlayWaiting(true);
      }

      if (isHost) {
        networkSync.broadcast({
          type: 'TABLE_SYNC',
          roomCode: prev.roomCode,
          tableState: nextTableState,
        });
      }

      return nextTableState;
    });
  };

  // Call UNO
  const executeCallUno = (playerId: string) => {
    soundFx.playUnoCall();
    setTableState((prev) => {
      const updated = prev.players.map((p) =>
        p.id === playerId ? { ...p, hasCalledUno: true } : p
      );
      const isPending = prev.unoCallPendingPlayerId === playerId;
      const nextState: GameTableState = {
        ...prev,
        players: updated,
        unoCallPendingPlayerId: isPending ? null : prev.unoCallPendingPlayerId,
        lastActionMessage: `🚨 ${prev.players.find((p) => p.id === playerId)?.name} called UNO!`,
        lastActionType: 'uno',
      };
      if (isHost) {
        networkSync.broadcast({
          type: 'TABLE_SYNC',
          roomCode: prev.roomCode,
          tableState: nextState,
        });
      }
      return nextState;
    });
  };

  // Catch someone who forgot UNO
  const executeCatchUno = (catcherId: string, targetPlayerId: string) => {
    soundFx.playUnoCaught();
    setTableState((prev) => {
      const targetIndex = prev.players.findIndex((p) => p.id === targetPlayerId);
      if (targetIndex === -1) return prev;

      const target = prev.players[targetIndex];
      const catcher = prev.players.find((p) => p.id === catcherId);

      const penaltyCount = prev.rules.unoPenaltyCards || 2;
      const penaltyCards = drawCardsFromDeck(penaltyCount);

      const updatedTarget: Player = {
        ...target,
        hand: [...target.hand, ...penaltyCards],
        handCount: target.hand.length + penaltyCards.length,
        hasCalledUno: false,
      };

      const updatedPlayers = [...prev.players];
      updatedPlayers[targetIndex] = updatedTarget;

      const nextState: GameTableState = {
        ...prev,
        players: updatedPlayers,
        unoCallPendingPlayerId: null,
        drawPileCount: fullDeckRef.current.length,
        lastActionMessage: `🚨 ${catcher?.name || 'Someone'} caught ${target.name} not calling UNO! +${penaltyCount} penalty cards!`,
        lastActionType: 'penalty',
      };

      if (isHost) {
        networkSync.broadcast({
          type: 'TABLE_SYNC',
          roomCode: prev.roomCode,
          tableState: nextState,
        });
      }

      return nextState;
    });
  };

  // Client Action Dispatchers
  const handleClientPlayCard = (
    cardId: string,
    chosenColor?: CardColor,
    calledUno?: boolean
  ) => {
    if (isHost) {
      executePlayCard(localPlayerId, cardId, chosenColor, calledUno);
    } else {
      networkSync.broadcast({
        type: 'ACTION_PLAY',
        roomCode: tableState.roomCode,
        playerId: localPlayerId,
        cardId,
        chosenColor,
        calledUno,
      });
    }
  };

  const handleClientDrawCard = () => {
    if (isHost) {
      executeDrawCard(localPlayerId);
    } else {
      networkSync.broadcast({
        type: 'ACTION_DRAW',
        roomCode: tableState.roomCode,
        playerId: localPlayerId,
      });
    }
  };

  const handleClientCallUno = () => {
    if (isHost) {
      executeCallUno(localPlayerId);
    } else {
      networkSync.broadcast({
        type: 'ACTION_CALL_UNO',
        roomCode: tableState.roomCode,
        playerId: localPlayerId,
      });
    }
  };

  const handleClientCatchUno = (targetId: string) => {
    if (isHost) {
      executeCatchUno(localPlayerId, targetId);
    } else {
      networkSync.broadcast({
        type: 'ACTION_CATCH_UNO',
        roomCode: tableState.roomCode,
        catcherId: localPlayerId,
        targetPlayerId: targetId,
      });
    }
  };

  // Next round dealer
  const handleNextRound = () => {
    if (!isHost) return;
    const { deck, tableState: dealtState } = startNewRound(tableState, rules);
    fullDeckRef.current = deck;
    setTableState(dealtState);

    networkSync.broadcast({
      type: 'TABLE_SYNC',
      roomCode: tableState.roomCode,
      tableState: dealtState,
    });
  };

  // Restart match from beginning
  const handleRestartMatch = () => {
    if (!isHost) return;
    const resetPlayers = tableState.players.map((p) => ({
      ...p,
      score: 0,
      hand: [],
      handCount: 0,
    }));
    const freshState: GameTableState = {
      ...tableState,
      players: resetPlayers,
      roundNumber: 0,
      matchWinnerId: null,
      roundWinnerId: null,
    };
    const { deck, tableState: dealtState } = startNewRound(freshState, rules);
    fullDeckRef.current = deck;
    setTableState(dealtState);

    networkSync.broadcast({
      type: 'TABLE_SYNC',
      roomCode: tableState.roomCode,
      tableState: dealtState,
    });
  };

  return (
    <div className="relative min-h-screen w-full bg-slate-950 font-sans text-slate-100">
      {/* Viewport Router */}
      {phase === 'TITLE' && (
        <TitleScreen
          onStartHost={handleStartHost}
          onStartJoin={() => setPhase('JOIN')}
          onStartPassAndPlay={() => setShowPassAndPlayPicker(true)}
          onOpenRules={() => setShowRules(true)}
          onOpenDiagnostics={() => setShowDiagnostics(true)}
          musicMuted={musicMuted}
          onToggleMusic={handleToggleMusic}
          sfxMuted={sfxMuted}
          onToggleSfx={handleToggleSfx}
        />
      )}

      {phase === 'HOST_SETUP' && (
        <HostSetupScreen
          defaultRoomCode={tableState.roomCode}
          onBack={handleLeaveRoom}
          onConfirmHost={handleConfirmHost}
        />
      )}

      {phase === 'JOIN' && (
        <JoinScreen
          initialRoomCode={tableState.roomCode}
          onBack={handleLeaveRoom}
          onConfirmJoin={handleConfirmJoin}
        />
      )}

      {phase === 'LOBBY' && (
        <LobbyScreen
          roomCode={tableState.roomCode}
          players={tableState.players}
          localPlayerId={localPlayerId}
          isHost={isHost}
          rules={tableState.rules}
          onRemovePlayer={handleRemovePlayer}
          onStartGame={handleHostStartGame}
          onLeaveRoom={handleLeaveRoom}
        />
      )}

      {phase === 'PLAYING' && (
        <>
          {/* Pass & Play Interstitial Screen */}
          {passAndPlayWaiting ? (
            <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center select-none animate-in fade-in duration-200">
              <div className="w-16 h-16 rounded-2xl bg-amber-400 shadow-xl shadow-amber-950/50 flex items-center justify-center font-heading font-black text-2xl text-slate-950 mb-4">
                !
              </div>
              <h2 className="font-heading font-extrabold text-2xl text-white mb-2">
                Pass Phone To{' '}
                <span className="text-amber-400">
                  {tableState.players[tableState.currentPlayerIndex]?.name}
                </span>
              </h2>
              <p className="text-xs text-slate-400 mb-6 max-w-xs">
                Keep the screen hidden from other players while passing the device.
              </p>
              <button
                type="button"
                onClick={() => {
                  soundFx.playClick();
                  setPassAndPlayWaiting(false);
                }}
                className="py-4 px-8 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white font-heading font-bold text-sm shadow-xl shadow-emerald-950/60 cursor-pointer"
              >
                I AM READY, SHOW MY HAND
              </button>
            </div>
          ) : (
            <GameTable
              tableState={tableState}
              localPlayerId={localPlayerId}
              isHost={isHost}
              onPlayCard={handleClientPlayCard}
              onDrawCard={handleClientDrawCard}
              onCallUno={handleClientCallUno}
              onCatchUno={handleClientCatchUno}
              onNextRound={handleNextRound}
              onRestartMatch={handleRestartMatch}
              onOpenRules={() => setShowRules(true)}
              onLeaveGame={handleLeaveRoom}
              musicMuted={musicMuted}
              onToggleMusic={handleToggleMusic}
              sfxMuted={sfxMuted}
              onToggleSfx={handleToggleSfx}
            />
          )}
        </>
      )}

      {/* Pass & Play Player Count Picker Modal (2 to 8 players) */}
      {showPassAndPlayPicker && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl text-center flex flex-col items-center gap-5">
            <div>
              <span className="text-xs font-bold text-amber-400 uppercase tracking-wider block">
                Pass & Play (1 Device)
              </span>
              <h2 className="font-heading font-extrabold text-xl text-white mt-1">
                How Many Players?
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Select between 2 to 8 human players
              </p>
            </div>

            <div className="grid grid-cols-4 gap-2.5 w-full">
              {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => {
                    soundFx.playClick();
                    handleStartPassAndPlay(count);
                  }}
                  className="py-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-amber-400 hover:bg-amber-400/10 font-heading font-extrabold text-lg text-white hover:text-amber-400 transition-all cursor-pointer shadow-sm"
                >
                  {count}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                soundFx.playClick();
                setShowPassAndPlayPicker(false);
              }}
              className="text-xs text-slate-500 hover:text-slate-300 font-semibold cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Global Rules Modal */}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}

      {/* Global Android Host Server Diagnostics Modal */}
      {showDiagnostics && (
        <DiagnosticsModal
          roomCode={tableState.roomCode}
          connectedCount={tableState.players.length || 1}
          onClose={() => setShowDiagnostics(false)}
        />
      )}
    </div>
  );
}
