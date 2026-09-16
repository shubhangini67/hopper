import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ClaimJobDto } from './dto/claim-job.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { QueryJobsDto } from './dto/query-jobs.dto';
import { UpdateJobStatusDto } from './dto/update-job-status.dto';
import { etagFor, parseIfMatch } from './job.types';
import { JobsService } from './jobs.service';

@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @SkipThrottle()
  @Get()
  index() {
    return {
      name: 'Hopper API',
      version: '1.1.0',
      endpoints: {
        'GET /health': 'Process + database ping',
        'POST /jobs': 'Create a pending job',
        'POST /jobs/claim': 'Claim the oldest waiting job that is not on hold',
        'POST /jobs/reap': 'Fail in-flight jobs whose lease expired',
        'GET /jobs': 'List jobs (query: status, type, q). Includes pulse',
        'GET /jobs/pulse': 'Queue health: stale leases, holds, dead letters',
        'GET /jobs/:id': 'Fetch one job',
        'POST /jobs/:id/hold': 'Park a waiting job so Claim next skips it',
        'POST /jobs/:id/release': 'Put a held job back in the claim line',
        'POST /jobs/:id/heartbeat': 'Extend the in-flight lease',
        'POST /jobs/:id/requeue': 'Queue a new pending copy of a terminal job',
        'PATCH /jobs/:id/status': 'Atomic status transition',
        'DELETE /jobs/:id': 'Delete a job',
      },
    };
  }

  @SkipThrottle()
  @Get('health')
  health() {
    this.jobs.ping();
    return { ok: true, service: 'hopper-api', time: new Date().toISOString() };
  }

  @Get('jobs/pulse')
  pulse() {
    return this.jobs.pulse();
  }

  @Get('jobs')
  list(@Query() query: QueryJobsDto) {
    return this.jobs.list(query);
  }

  @Get('jobs/:id')
  getOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.getById(id);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs')
  create(
    @Body() dto: CreateJobDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.create(dto, idempotencyKey?.trim() || undefined);
    res.status(201);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs/claim')
  @HttpCode(200)
  claim(
    @Body() dto: ClaimJobDto,
    @Headers('x-hopper-operator') headerOperator: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.claimNext(headerOperator?.trim() || dto.operator);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs/reap')
  @HttpCode(200)
  reap() {
    return this.jobs.reapStale();
  }

  @Post('jobs/:id/hold')
  @HttpCode(200)
  hold(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ClaimJobDto,
    @Headers('x-hopper-operator') headerOperator: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.hold(id, headerOperator?.trim() || dto.operator);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs/:id/release')
  @HttpCode(200)
  release(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.release(id);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs/:id/heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.heartbeat(id);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Post('jobs/:id/requeue')
  requeue(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.requeue(id);
    res.status(201);
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Patch('jobs/:id/status')
  updateStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateJobStatusDto,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('x-hopper-operator') operator: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const job = this.jobs.updateStatus(id, dto.status, {
      from: dto.from,
      ifMatch: parseIfMatch(ifMatch),
      error: dto.error,
      operator: operator?.trim(),
    });
    res.setHeader('ETag', etagFor(job));
    return job;
  }

  @Delete('jobs/:id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    this.jobs.remove(id);
  }
}
