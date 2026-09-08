-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('upcoming', 'live', 'finished');

-- CreateEnum
CREATE TYPE "PollStatus" AS ENUM ('open', 'locked', 'resolved', 'void');

-- CreateTable
CREATE TABLE "sessions" (
    "session_key" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "circuit_key" INTEGER NOT NULL,
    "date_start" TIMESTAMP(3) NOT NULL,
    "date_end" TIMESTAMP(3) NOT NULL,
    "total_laps" INTEGER,
    "status" "SessionStatus" NOT NULL,
    "exported_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("session_key")
);

-- CreateTable
CREATE TABLE "events" (
    "event_id" TEXT NOT NULL,
    "session_key" BIGINT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "source_time" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "polls" (
    "poll_id" TEXT NOT NULL,
    "session_key" BIGINT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "locks_at_lap" INTEGER NOT NULL,
    "status" "PollStatus" NOT NULL,
    "winning_option_ids" JSONB,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "polls_pkey" PRIMARY KEY ("poll_id")
);

-- CreateTable
CREATE TABLE "votes" (
    "poll_id" TEXT NOT NULL,
    "viewer_id" UUID NOT NULL,
    "option_id" TEXT NOT NULL,
    "voted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("poll_id","viewer_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "events_seq_key" ON "events"("seq");

-- CreateIndex
CREATE INDEX "events_session_key_source_time_idx" ON "events"("session_key", "source_time");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_session_key_fkey" FOREIGN KEY ("session_key") REFERENCES "sessions"("session_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polls" ADD CONSTRAINT "polls_session_key_fkey" FOREIGN KEY ("session_key") REFERENCES "sessions"("session_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_poll_id_fkey" FOREIGN KEY ("poll_id") REFERENCES "polls"("poll_id") ON DELETE RESTRICT ON UPDATE CASCADE;
