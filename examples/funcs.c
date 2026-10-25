int add(int x, int y) {
  return x + y;
}

int mul(int x, int y) {
  return x * y;
}

int main() {
  int r = add(1, 2);
  return add(r, mul(3, 4));
}
