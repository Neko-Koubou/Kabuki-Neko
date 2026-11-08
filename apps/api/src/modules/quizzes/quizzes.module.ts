import { Module } from "@nestjs/common";
import { CommonModule } from "../../common/common.module";
import { QuizzesController } from "./quizzes.controller";
import { QuizzesService } from "./quizzes.service";

/**
 * Quiz authoring module: CRUD, duplication, JSON export, import templates and multipart
 * JSON/CSV import (SA §4.3). The service is exported so the game engine can reuse authorized
 * quiz reads and snapshots without duplicating ownership rules.
 */
@Module({
  imports: [CommonModule],
  controllers: [QuizzesController],
  providers: [QuizzesService],
  exports: [QuizzesService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest module metadata container.
export class QuizzesModule {}
