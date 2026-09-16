import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ClaimJobDto {
  @IsOptional()
  @IsString()
  @MaxLength(40, { message: 'Operator name must be at most 40 characters.' })
  operator?: string;
}
