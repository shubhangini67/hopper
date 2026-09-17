import { config } from 'dotenv';
config();

import { createHopperApp } from './create-app';

async function bootstrap() {
  const app = await createHopperApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
}

bootstrap();
