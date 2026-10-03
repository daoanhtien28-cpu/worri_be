import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'OldPass@123',
    description: 'Mật khẩu hiện tại',
  })
  @IsNotEmpty({ message: 'Mật khẩu hiện tại không được để trống' })
  @IsString({ message: 'Mật khẩu hiện tại phải là chuỗi ký tự' })
  currentPassword: string;

  @ApiProperty({
    example: 'NewPass@123',
    description: 'Mật khẩu mới (tối thiểu 6 ký tự, có ít nhất 1 chữ hoa và 1 ký tự đặc biệt)',
  })
  @IsNotEmpty({ message: 'Mật khẩu mới không được để trống' })
  @IsString({ message: 'Mật khẩu mới phải là chuỗi ký tự' })
  @MinLength(6, { message: 'Mật khẩu mới phải có độ dài tối thiểu 6 ký tự' })
  @Matches(/[A-Z]/, { message: 'Mật khẩu mới phải chứa ít nhất 1 ký tự viết hoa' })
  @Matches(/[^a-zA-Z0-9]/, { message: 'Mật khẩu mới phải chứa ít nhất 1 ký tự đặc biệt' })
  newPassword: string;
}
