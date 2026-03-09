const supabase = require("../config/supabase");

async function registerCar(userId, plate, carName) {

  let { data: car } = await supabase
    .from("cars")
    .select("*")
    .eq("plate_number", plate)
    .single();

  if (!car) {
    const { data: newCar } = await supabase
      .from("cars")
      .insert({
        plate_number: plate,
        car_name: carName.toLowerCase()
      })
      .select()
      .single();
    car = newCar;
  }

  await supabase.from("car_users").insert({
    user_id: userId,
    car_id: car.id,
    role: "owner"
  });

  return car;
}

async function getUserCars(userId) {
  const { data } = await supabase
    .from("car_users")
    .select(`
      car_id,
      cars (
        id,
        car_name,
        plate_number
      )
    `)
    .eq("user_id", userId);

  if (!data) return [];
  return data.map(row => row.cars);
}

async function setActiveCar(userId, carId) {
  const { error } = await supabase
    .from("users")
    .update({ active_car_id: carId })
    .eq("id", userId);

  if (error) {
    console.error("setActiveCar error:", error);
    return false;
  }
  return true;
}

module.exports = { registerCar, getUserCars, setActiveCar };