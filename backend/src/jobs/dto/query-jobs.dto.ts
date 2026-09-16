import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JOB_STATUSES, JOB_TYPES } from '../job-status';

export class QueryJobsDto {
  @IsOptional()
  @IsIn(['all', ...JOB_STATUSES], {
    message: 'status must be all, pending, running, completed, or failed.',
  })
  status?: string;

  @IsOptional()
  @IsIn(JOB_TYPES, {
    message: `type must be one of: ${JOB_TYPES.join(', ')}.`,
  })
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}
