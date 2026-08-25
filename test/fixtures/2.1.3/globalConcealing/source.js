function add3(a, b, c) {
  var total = a + b + c;
  var label = total > 5 ? "large" : "small";
  console.log(label);
  return total;
}

function twice(x) {
  var first = add3(x, x, 0);
  if (first % 2 === 0) {
    return first * 2;
  }
  return first + 1;
}

function scenario(value) {
  var current = twice(value);
  for (var i = 0; i < 2; i++) {
    current = current + i;
  }
  return current;
}

module.exports = { add3, twice, scenario };
