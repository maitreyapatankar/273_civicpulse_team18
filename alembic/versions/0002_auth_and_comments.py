"""auth and comments

Revision ID: 0002
Revises: 0001
Create Date: 2026-05-01

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "citizens",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index("idx_citizens_email", "citizens", ["email"], unique=True)

    op.create_table(
        "officers",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False, server_default="officer"),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index("idx_officers_email", "officers", ["email"], unique=True)

    op.add_column(
        "raw_reports",
        sa.Column("citizen_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_raw_reports_citizen",
        "raw_reports",
        "citizens",
        ["citizen_id"],
        ["id"],
    )

    op.create_table(
        "ticket_comments",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "ticket_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tickets.id"),
            nullable=False,
        ),
        sa.Column("author_type", sa.Text(), nullable=False),
        sa.Column("author_id", postgresql.UUID(as_uuid=True)),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("is_public", sa.Boolean(), server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.text("NOW()"),
        ),
    )
    op.create_index(
        "idx_ticket_comments_ticket", "ticket_comments", ["ticket_id"]
    )


def downgrade() -> None:
    op.drop_index("idx_ticket_comments_ticket", table_name="ticket_comments")
    op.drop_table("ticket_comments")

    op.drop_constraint("fk_raw_reports_citizen", "raw_reports", type_="foreignkey")
    op.drop_column("raw_reports", "citizen_id")

    op.drop_index("idx_officers_email", table_name="officers")
    op.drop_table("officers")

    op.drop_index("idx_citizens_email", table_name="citizens")
    op.drop_table("citizens")
