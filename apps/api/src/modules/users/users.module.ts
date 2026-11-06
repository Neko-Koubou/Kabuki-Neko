import { Module } from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { InvitationsService } from "./invitations.service";

@Module({
  imports: [CommonModule],
  controllers: [UsersController],
  providers: [UsersService, InvitationsService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class UsersModule {}
