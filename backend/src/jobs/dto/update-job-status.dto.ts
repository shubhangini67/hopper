import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JOB_STATUSES } from '../job-status';
import type { JobStatus } from '../job-status';

export class UpdateJobStatusDto {
  @IsIn(JOB_STATUSES, {
    message: `Status must be one of: ${JOB_STATUSES.join(', ')}.`,
  })
  status!: JobStatus;

  @IsIn(JOB_STATUSES, {
    message: 'from must be the status you last read on this job.',
  })
  from!: JobStatus;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  error?: string;
}
