import { config } from 'dotenv';
config();

import type { Request, Response } from 'express';
import express from 'express';
import { createHopperApp } from '../src/create-app';

const server = express();
let ready: Promise<void> | undefined;

function boot(): Promise<void> {
  ready ??= createHopperApp(server).then(async (app) => {
    await app.init();
  });
  return ready;
}

export default async function handler(req: Request, res: Response): Promise<void> {
  process.env.DATABASE_PATH ??= '/tmp/hopper.sqlite';
  await boot();
  server(req, res);
}
