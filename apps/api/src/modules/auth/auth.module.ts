import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { CommonModule } from "../../common/common.module";
import { AuthController } from "./auth.controller";
import { AuthService, PasswordHasher } from "./auth.service";
import { SetupService } from "./setup.service";

@Module({
  imports: [CommonModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordHasher, SetupService],
  exports: [AuthService, PasswordHasher, SetupService],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser()).forRoutes(AuthController);
  }
}
