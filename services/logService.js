const supabase = require("../config/supabase");

async function saveLog(carId, type, amount, description, mileage = null) {

  const { data, error } = await supabase
    .from("logs")
    .insert({
      car_id: carId,
      type: type,
      amount: amount,
      mileage: mileage,
      description: description
    })
    .select()
    .single();

  if (error) {
    console.error("Log save error:", error);
    return null;
  }

  return data;
}

async function getRecentLogs(carId, limit = 5) {

  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("car_id", carId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return data || [];
}

async function getLogsThisMonth(carId) {

  const now = new Date();

  const firstDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    1
  );

  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("car_id", carId)
    .gte("log_date", firstDay.toISOString())
    .order("log_date", { ascending: false });

  return data || [];

}

async function deleteLastLog(carId) {

  const { data: lastLog } = await supabase
    .from("logs")
    .select("id")
    .eq("car_id", carId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!lastLog) return null;

  await supabase
    .from("logs")
    .delete()
    .eq("id", lastLog.id);

  return lastLog;

}

module.exports = { saveLog, getRecentLogs, getLogsThisMonth, deleteLastLog };