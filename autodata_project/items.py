import scrapy


class CarSpecItem(scrapy.Item):
    brand = scrapy.Field()
    model = scrapy.Field()
    generation = scrapy.Field()

    # All remaining spec keys are stored dynamically; declare a catch-all field.
    # At runtime we add arbitrary keys directly to the dict-like Item.
    specs = scrapy.Field()
