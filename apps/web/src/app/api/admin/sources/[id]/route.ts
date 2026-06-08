import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedRequest } from "@/lib/auth";
import { query } from "@/lib/db";

// PATCH /api/admin/sources/[id] - Update source
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticatedRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const sourceId = parseInt(id, 10);

  if (isNaN(sourceId)) {
    return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
  }

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
    const rows = await query<Record<string, unknown>>(
      `UPDATE sources SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, source: rows[0] });
  } catch (error) {
    console.error("Error updating source:", error);
    return NextResponse.json({ error: "Failed to update source" }, { status: 500 });
  }
}

// DELETE /api/admin/sources/[id] - Delete source
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isAuthenticatedRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const sourceId = parseInt(id, 10);

  if (isNaN(sourceId)) {
    return NextResponse.json({ error: "Invalid source ID" }, { status: 400 });
  }

  try {
    // Check if source has content
    const contentCheck = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM content WHERE source_id = $1",
      [sourceId]
    );

    if (parseInt(contentCheck[0].count, 10) > 0) {
      return NextResponse.json(
        { error: "Cannot delete source with associated content. Deactivate it instead." },
        { status: 400 }
      );
    }

    const rows = await query<{ id: number }>(
      "DELETE FROM sources WHERE id = $1 RETURNING id",
      [sourceId]
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting source:", error);
    return NextResponse.json({ error: "Failed to delete source" }, { status: 500 });
  }
}
