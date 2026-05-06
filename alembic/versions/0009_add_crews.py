"""add crews table and crew_id to tickets

Revision ID: 0009
Revises: 0008
Create Date: 2026-05-05
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'crews',
        sa.Column('id', UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('team_name', sa.Text(), nullable=False, unique=True),
        sa.Column('crew_type', sa.Text(), nullable=False),
        sa.Column('lead_name', sa.Text(), nullable=False),
        sa.Column('lead_email', sa.Text(), nullable=False),
        sa.Column('created_at', sa.TIMESTAMP(timezone=True), server_default=sa.text('now()')),
    )
    op.add_column('tickets', sa.Column('crew_id', UUID(as_uuid=True), sa.ForeignKey('crews.id'), nullable=True))


def downgrade():
    op.drop_column('tickets', 'crew_id')
    op.drop_table('crews')
