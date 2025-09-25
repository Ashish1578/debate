
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';
import Redis from 'ioredis';
import helmet from 'helmet';
import cors from 'cors';
import pino from 'pino';
import { createAdapter } from 'socket.io-redis';
import { Matchmaker } from './system/matchmaker';
import { setupApi } from './system/api';
import path from 'path';


const logger = pino();
const app = express();
const server = http.createServer(app);


app.use(helmet());
app.use(cors());
app.use(express.json());


// Serve static client
app.use(express.static(path.join(__dirname, 'public')));


const io = new IOServer(server, { cors: { origin: '*' } });


const redis = new Redis(process.env.REDIS_URL);
io.adapter(createAdapter({ pubClient: redis.duplicate(), subClient: redis.duplicate() }));


setupApi(app, { logger, redis });


const matchmaker = new Matchmaker({ io, redis, logger });
matchmaker.attach();


const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => logger.info(`Server listening on ${PORT}`));

