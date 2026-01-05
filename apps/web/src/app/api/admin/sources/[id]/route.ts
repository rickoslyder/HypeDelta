import { NextRequest, NextResponse } from "next/server";
import { validateAuthToken } from "@/lib/auth";
import { cookies } from "next/headers";
import pg from "pg";

const { Pool } = pg;

function getPool() {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

// Validate admin auth
async function validateAuth(request: NextRequest): Promise<boolean> {
  const cookieStore = await cookies();
  const authCookie = cookieStore.get("admin-auth");
  const secret = process.env.ADMIN_PASSWORD;

  if (!authCookie?.value || !secret) {
    return false;
  }

  return validateAuthToken(decodeURIComponent(authCookie.value), secret);
}

// PATCH /api/admin/sources/[id] - Update source
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await validateAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const sourceId = parseInt(id, 10);

  if (isNaN(sourceId)) {
    return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
  }

  const pool = getPool();

  try {
    const body = await request.json();
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Handle is_active toggle
    if (typeof body.is_active === "boolean") {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(body.is_active);
    }

    // Handle fetch_frequency_hours
    if (typeof body.fetch_frequency_hours === "number") {
      updates.push(`fetch_frequency_hours = $${paramIndex++}`);
      values.push(body.fetch_frequency_hours);
    }

    // Handle author_name
    if (typeof body.author_name === "string") {
      updates.push(`author_name = $${paramIndex++}`);
      values.push(body.author_name || null);
    }

    // Handle category
    if (typeof body.category === "string") {
      updates.push(`category = $${paramIndex++}`);
      values.push(body.category || null);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    values.push(sourceId);
    const result = await pool.query(
      `UPDATE sources SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    await pool.end();

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, source: result.rows[0] });
  } catch (error) {
    await pool.end();
    console.error("Error updating source:", error);
    return NextResponse.json({ error: "Failed to update source" }, { status: 500 });
  }
}

// DELETE /api/admin/sources/[id] - Delete source
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await validateAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const sourceId = parseInt(id, 10);

  if (isNaN(sourceId)) {
    return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
  }

  const pool = getPool();

  try {
    // Check if source has content
    const contentCheck = await pool.query(
      "SELECT COUNT(*) as count FROM content WHERE source_id = $1",
      [sourceId]
    );

    if (parseInt(contentCheck.rows[0].count, 10) > 0) {
      await pool.end();
      return NextResponse.json(
        { error: "Cannot delete source with associated content. Deactivate it instead." },
        { status: 400 }
      );
    }

    const result = await pool.query(
      "DELETE FROM sources WHERE id = $1 RETURNING id",
      [sourceId]
    );

    await pool.end();

    if (result.rows.length === 0) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    await pool.end();
    console.error("Error deleting source:", error);
    return NextResponse.json({ error: "Failed to delete source" }, { status: 500 });
  }
}
