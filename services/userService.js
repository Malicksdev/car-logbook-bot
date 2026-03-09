const supabase = require("../config/supabase");

async function getOrCreateUser(phone, name) {

  let isNewUser = false;

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number", phone)
    .single();

  if (!user) {

    isNewUser = true;

    const { data: newUser } = await supabase
      .from("users")
      .insert({
        phone_number: phone,
        name: name
      })
      .select()
      .single();

    user = newUser;
  }

  return { user, isNewUser };
}

module.exports = { getOrCreateUser };