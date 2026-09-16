import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { JOB_TYPES } from '../job-status';
import type { JobType } from '../job-status';

export class CreateJobDto {
  @IsString()
  @MinLength(3, { message: 'Title must be at least 3 characters.' })
  @MaxLength(120, { message: 'Title must be at most 120 characters.' })
  title!: string;

  @IsIn(JOB_TYPES, {
    message: `Type must be one of: ${JOB_TYPES.join(', ')}.`,
  })
  type!: JobType;
}
