import { Server as IOServer, Socket } from 'socket.io';
import { Logger } from 'pino';

interface WaitingUser {
  socketId: string;
  tags: string[];
  timestamp: number;
}

interface ActiveRoom {
  users: string[];
  topic: string;
  startTime: number;
  duration: number;
}

export class Matchmaker {
  private io: IOServer;
  private logger: Logger;
  private waitingUsers = new Map<string, WaitingUser>();
  private activeRooms = new Map<string, ActiveRoom>();
  private userRoomMap = new Map<string, string>();

  // Debate topics pool
  private readonly DEBATE_TOPICS = [
    "Pineapple belongs on pizza",
    "Cats are better than dogs",
    "Is a hotdog a sandwich?",
    "Should toilet paper hang over or under?",
    "Is water wet?",
    "Are birds real or government drones?",
    "Is cereal a soup?",
    "Should you shower in the morning or at night?",
    "Is math invented or discovered?",
    "Would you rather fight 100 duck-sized horses or 1 horse-sized duck?",
    "Is it better to be too hot or too cold?",
    "Should you put milk or cereal first?",
    "Are video games a sport?",
    "Is time travel possible?",
    "Should robots have rights?",
    "Is social media good or bad for society?",
    "Should we colonize Mars?",
    "Is artificial intelligence a threat to humanity?",
    "Should college be free?",
    "Is remote work better than office work?",
    "Should social media platforms be regulated?",
    "Is cryptocurrency the future of money?",
    "Should school start later in the day?",
    "Is it better to live in the city or countryside?",
    "Should everyone learn to code?"
  ];

  constructor(io: IOServer, logger: Logger) {
    this.io = io;
    this.logger = logger;
    this.logger.info('Matchmaker initialized in memory-only mode');
  }

  private getRandomTopic(): string {
    return this.DEBATE_TOPICS[Math.floor(Math.random() * this.DEBATE_TOPICS.length)];
  }

  private generateRoomId(): string {
    return `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private findMatchingUser(userId: string, userTags: string[]): string | null {
    for (const [waitingId, waitingData] of this.waitingUsers.entries()) {
      if (waitingId === userId) continue;

      // Check for tag match
      const hasCommonTags = userTags.some(tag =>
        waitingData.tags.some(wtag =>
          wtag.toLowerCase() === tag.toLowerCase()
        )
      );

      if (hasCommonTags || (userTags.length === 0 && waitingData.tags.length === 0)) {
        return waitingId;
      }
    }

    // If no tag match, return any waiting user
    for (const [waitingId] of this.waitingUsers.entries()) {
      if (waitingId !== userId) return waitingId;
    }

    return null;
  }

  async handleFindMatch(socket: Socket, tags: string[] = []): Promise<void> {
    const userId = socket.id;
    this.logger.info(`User ${userId} searching with tags: ${tags.join(', ')}`);

    // Check if already in a room
    if (this.userRoomMap.has(userId)) {
      socket.emit('system', 'You are already in a debate!');
      return;
    }

    // Try to find a match
    const matchId = this.findMatchingUser(userId, tags);

    if (matchId) {
      // Create room and match users
      const roomId = this.generateRoomId();
      const topic = this.getRandomTopic();
      const duration = parseInt(process.env.ROOM_DURATION_MINUTES || '5') * 60; // Convert to seconds

      const roomData: ActiveRoom = {
        users: [userId, matchId],
        topic,
        startTime: Date.now(),
        duration
      };

      this.activeRooms.set(roomId, roomData);
      this.userRoomMap.set(userId, roomId);
      this.userRoomMap.set(matchId, roomId);

      // Remove from waiting queue
      this.waitingUsers.delete(matchId);

      // Join both users to room
      socket.join(roomId);
      const matchSocket = this.io.sockets.sockets.get(matchId);
      if (matchSocket) {
        matchSocket.join(roomId);
      }

      // Notify both users
      this.io.to(roomId).emit('matched', {
        roomId,
        topic,
        duration: duration * 1000 // Convert to milliseconds for frontend
      });

      this.logger.info(`Matched ${userId} and ${matchId} in room ${roomId}`);

      // Set room timeout
      setTimeout(() => {
        this.endRoom(roomId, 'Time expired');
      }, duration * 1000);

    } else {
      // Add to waiting queue
      this.waitingUsers.set(userId, { 
        socketId: userId, 
        tags, 
        timestamp: Date.now() 
      });
      socket.emit('system', 'Waiting for an opponent...');
    }
  }

  async handleMessage(socket: Socket, roomId: string, text: string): Promise<void> {
    if (!roomId || !this.activeRooms.has(roomId)) return;
    if (this.userRoomMap.get(socket.id) !== roomId) return;

    // Validate message
    if (!text || text.trim().length === 0 || text.length > 500) return;

    // Broadcast message to room
    this.io.to(roomId).emit('msg', {
      from: socket.id,
      text: text.trim(),
      timestamp: Date.now()
    });
  }

  async skipDebate(socket: Socket): Promise<void> {
    const userId = socket.id;
    const roomId = this.userRoomMap.get(userId);

    if (!roomId) {
      // If waiting, remove from queue
      this.waitingUsers.delete(userId);
      socket.emit('system', 'Search cancelled');
      return;
    }

    // End current room
    this.endRoom(roomId, 'User skipped');
  }

  async endDebate(socket: Socket, roomId: string): Promise<void> {
    if (!roomId || !this.activeRooms.has(roomId)) return;
    this.endRoom(roomId, 'User ended the debate');
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const userId = socket.id;

    // Remove from waiting queue
    this.waitingUsers.delete(userId);

    // Check if in a room
    const roomId = this.userRoomMap.get(userId);
    if (roomId) {
      this.endRoom(roomId, 'User disconnected');
    }
  }

  private endRoom(roomId: string, reason: string): void {
    const room = this.activeRooms.get(roomId);
    if (!room) return;

    // Notify all users in room
    this.io.to(roomId).emit('room_ended', { reason });

    // Clean up
    room.users.forEach(userId => {
      this.userRoomMap.delete(userId);
      const userSocket = this.io.sockets.sockets.get(userId);
      if (userSocket) {
        userSocket.leave(roomId);
      }
    });

    this.activeRooms.delete(roomId);
    this.logger.info(`Room ${roomId} ended: ${reason}`);
  }

  // Public methods for API
  getStats() {
    return {
      activeRooms: this.activeRooms.size,
      waitingUsers: this.waitingUsers.size,
      totalConnections: this.io.sockets.sockets.size
    };
  }

  getTopics() {
    return this.DEBATE_TOPICS;
  }
}
