import { Module } from '@nestjs/common';
import { PythonSocket } from './python.socket';

@Module({
  providers: [PythonSocket],
  exports: [PythonSocket],
})
export class PythonModule {}